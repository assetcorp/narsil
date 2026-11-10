package partition

import (
	"math"
	"sync/atomic"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
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
}

func NewSides(slots *vector.Slots) *Sides {
	return &Sides{slots: slots}
}

func (s *Sides) Slots() *vector.Slots {
	return s.slots
}

func (s *Sides) Add(partition *Partition) {
	s.partitions = append(s.partitions, partition)
}

func (s *Sides) Remove(partition *Partition) {
	for at, held := range s.partitions {
		if held == partition {
			s.partitions = append(s.partitions[:at:at], s.partitions[at+1:]...)
			return
		}
	}
}

type Write struct {
	Workspace *core.Workspace
	Sequence  int64
	side      int
}

func (s *Sides) claim(side int) {
	s.heldState[side].Store(stateBeingWritten)
	delay := SideReaderWaitFirstDelay
	for s.readers[side].Load() != 0 {
		time.Sleep(delay)
		delay = min(delay*2, SideReaderWaitMaxDelay)
	}
}

func (s *Sides) Write(apply func(write *Write) error) error {
	return s.slots.Write(func(sequence int64) error {
		side := 1 - int(s.latest.Load()&1)
		s.claim(side)
		w, err := core.AcquireWorkspace()
		if err != nil {
			return err
		}
		defer w.Release()
		write := &Write{Workspace: w, Sequence: sequence, side: side}
		for _, partition := range s.partitions {
			if err := partition.catchUp(write); err != nil {
				return err
			}
		}
		err = apply(write)
		documents := 0
		for _, partition := range s.partitions {
			documents += partition.sides[side].documentCount()
		}
		s.documents.Store(int64(documents))
		s.heldState[side].Store(sequence)
		s.latest.Store(sequence<<1 | int64(side))
		return err
	})
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

func (s *Sides) Read() (*Read, error) {
	for {
		lease, err := s.slots.AcquireSearch()
		if err != nil {
			return nil, err
		}
		if side, entered := s.enter(lease.Pin()); entered {
			return &Read{lease: lease, side: side, hold: &sideHold{sides: s}}, nil
		}
		lease.Release()
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
