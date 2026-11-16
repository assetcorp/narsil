package partition

import (
	"context"
	"math"
	"runtime"
	"sync/atomic"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
)

const (
	sideCount         = 2
	stateBeingWritten = math.MaxInt64
)

type Sides struct {
	slots      *vector.Slots
	partitions []*Partition
	latest     atomic.Int64
	documents  atomic.Int64
	heldState  [sideCount]atomic.Int64
	readers    [sideCount]atomic.Int64
	gate       atomic.Pointer[chan struct{}]
	waiting    atomic.Int64
}

func NewSides(slots *vector.Slots) *Sides {
	return &Sides{slots: slots}
}

func (s *Sides) Add(partition *Partition) {
	s.partitions = append(s.partitions, partition)
}

type Write struct {
	Workspace *core.Workspace
	Sequence  int64
	Tokens    *analysis.Pass
	side      int
}

func (s *Sides) claim(ctx context.Context, side int) error {
	held := s.heldState[side].Load()
	s.heldState[side].Store(stateBeingWritten)
	stopped := ctx.Done()
	delay := SideReaderWaitFirstDelay
	for s.readers[side].Load() != 0 {
		select {
		case <-stopped:
			s.heldState[side].Store(held)
			return ctx.Err()
		default:
		}
		time.Sleep(delay)
		delay = min(delay*2, SideReaderWaitMaxDelay)
	}
	return nil
}

func (s *Sides) Write(ctx context.Context, apply func(write *Write) error) error {
	return s.write(ctx, false, apply)
}

func (s *Sides) WriteInPlace(ctx context.Context, apply func(write *Write) error) error {
	return s.write(ctx, true, apply)
}

func (s *Sides) write(ctx context.Context, inPlace bool, apply func(write *Write) error) error {
	var gate chan struct{}
	err := s.slots.WriteContext(ctx, func(sequence int64) error {
		w, err := core.AcquireWorkspace()
		if err != nil {
			return err
		}
		defer w.Release()
		published := int(s.latest.Load() & 1)
		if inPlace && s.waiting.Load() == 0 && !s.freezesNext(published) {
			gate = s.closeGate(published)
		}
		write := &Write{Workspace: w, Sequence: sequence, side: published}
		if gate != nil {
			s.heldState[1-published].Store(stateBeingWritten)
		} else {
			write.side = 1 - published
			if err := s.catchUp(ctx, write); err != nil {
				return err
			}
		}
		err = apply(write)
		if gate != nil && s.readers[1-published].Load() == 0 {
			for _, partition := range s.partitions {
				partition.dropBacklog()
			}
		}
		s.publish(write)
		return err
	})
	if gate != nil {
		s.gate.Store(nil)
		close(gate)
	}
	return err
}

func (s *Sides) freezesNext(side int) bool {
	for _, partition := range s.partitions {
		if partition.freezesNext(side) {
			return true
		}
	}
	return false
}

func (s *Sides) closeGate(side int) chan struct{} {
	opened := make(chan struct{})
	s.gate.Store(&opened)
	held := s.heldState[side].Load()
	s.heldState[side].Store(stateBeingWritten)
	if s.readers[side].Load() == 0 {
		return opened
	}
	s.heldState[side].Store(held)
	s.gate.Store(nil)
	close(opened)
	return nil
}

func (s *Sides) catchUp(ctx context.Context, write *Write) error {
	if err := s.claim(ctx, write.side); err != nil {
		return err
	}
	for _, partition := range s.partitions {
		if err := partition.catchUp(write); err != nil {
			return err
		}
	}
	return nil
}

func (s *Sides) publish(write *Write) {
	documents := 0
	for _, partition := range s.partitions {
		documents += partition.sides[write.side].documentCount()
	}
	s.documents.Store(int64(documents))
	s.heldState[write.side].Store(write.Sequence)
	s.latest.Store(write.Sequence<<1 | int64(write.side))
}

func (s *Sides) DocumentCount() int {
	return int(s.documents.Load())
}

func (s *Sides) enter(pin int64) (int, bool) {
	latest := s.latest.Load()
	side := int(latest & 1)
	if pin < latest>>1 {
		side = 1 - side
	}
	s.readers[side].Add(1)
	if pin < s.heldState[side].Load() || s.latest.Load() != latest {
		s.readers[side].Add(-1)
		return 0, false
	}
	return side, true
}

type sideHold struct {
	sides *Sides
	left  atomic.Bool
}

type Read struct {
	lease *vector.Lease
	side  int
	hold  *sideHold
}

func (s *Sides) Read(ctx context.Context) (*Read, error) {
	return s.read(ctx, true)
}

func (s *Sides) readWithoutLease(ctx context.Context) (*Read, error) {
	return s.read(ctx, false)
}

func (s *Sides) viewForRead(leased bool) (*vector.Lease, int64, error) {
	if !leased {
		return nil, s.slots.Sequence(), nil
	}
	lease, err := s.slots.AcquireSearch()
	if err != nil {
		return nil, 0, err
	}
	return lease, lease.Pin(), nil
}

func (s *Sides) read(ctx context.Context, leased bool) (*Read, error) {
	waited := false
	defer func() {
		if waited {
			s.waiting.Add(-1)
		}
	}()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		lease, pin, err := s.viewForRead(leased)
		if err != nil {
			return nil, err
		}
		if side, entered := s.enter(pin); entered {
			return &Read{lease: lease, side: side, hold: &sideHold{sides: s}}, nil
		}
		gate := s.gate.Load()
		lease.Release()
		if gate == nil {
			runtime.Gosched()
			continue
		}
		if !waited {
			waited = true
			s.waiting.Add(1)
		}
		select {
		case <-*gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func (r *Read) Of(sides *Sides) bool {
	return r.hold != nil && r.hold.sides == sides
}

func (r *Read) Borrow() (*Read, bool) {
	if r.hold == nil || r.hold.left.Load() {
		return nil, false
	}
	return &Read{lease: r.lease, side: r.side}, true
}

func (r *Read) Lease() *vector.Lease {
	return r.lease
}

func (r *Read) LeaveSide() {
	if r.hold != nil && r.hold.left.CompareAndSwap(false, true) {
		r.hold.sides.readers[r.side].Add(-1)
	}
}

func (r *Read) Release() {
	if r.hold == nil {
		return
	}
	r.LeaveSide()
	r.lease.Release()
}
