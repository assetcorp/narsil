package vector

import (
	"math"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	pinEntryBytes      = 8
	slotLinkBytes      = 4
	heldLockRowBytes   = core.HeldWordsPerThread * 4
	threadSlotCapacity = MaxSearchThreadSlots + maxWriterThreadSlots
	freeListTagShift   = 32
	freeListSlotMask   = 1<<freeListTagShift - 1
	noPinHeld          = math.MaxInt64
)

type Slots struct {
	resource  *sharedResource
	pins      *core.SharedRegion
	heldLocks *core.SharedRegion
	links     *core.SharedRegion
	handedOut atomic.Uint32
	free      atomic.Uint64
	searching atomic.Int32
	writers   atomic.Int32
	sequence  atomic.Int64
	writeMu   sync.Mutex
}

func NewSlots() (*Slots, error) {
	slots := &Slots{}
	sizes := []struct {
		target **core.SharedRegion
		bytes  uintptr
	}{
		{&slots.pins, threadSlotCapacity * pinEntryBytes},
		{&slots.heldLocks, threadSlotCapacity * heldLockRowBytes},
		{&slots.links, threadSlotCapacity * slotLinkBytes},
	}
	for _, size := range sizes {
		region, err := core.ReserveSharedRegion(size.bytes)
		if err != nil {
			slots.releaseRegions()
			return nil, regionFailure(err, size.bytes, size.bytes)
		}
		*size.target = region
	}
	slots.resource = newSharedResource(slots.releaseRegions)
	return slots, nil
}

func (s *Slots) Close() {
	s.resource.drop()
}

func (s *Slots) Retain() *Slots {
	s.resource.retain()
	return s
}

func (s *Slots) releaseRegions() {
	for _, region := range []*core.SharedRegion{s.pins, s.heldLocks, s.links} {
		if region != nil {
			region.Release()
		}
	}
}

func (s *Slots) Sequence() int64 {
	return s.sequence.Load()
}

func (s *Slots) Write(apply func(sequence int64) error) error {
	s.writeMu.Lock()
	sequence := s.sequence.Load() + 1
	defer func() {
		s.sequence.Store(sequence)
		s.writeMu.Unlock()
	}()
	return apply(sequence)
}

func (s *Slots) raiseSequenceTo(sequence int64) {
	for {
		seen := s.sequence.Load()
		if seen >= sequence || s.sequence.CompareAndSwap(seen, sequence) {
			return
		}
	}
}

func (s *Slots) pinEntry(slot uint32) *atomic.Int64 {
	return (*atomic.Int64)(unsafe.Add(s.pins.Pointer(), uintptr(slot)*pinEntryBytes))
}

func (s *Slots) link(slot uint32) *atomic.Uint32 {
	return (*atomic.Uint32)(unsafe.Add(s.links.Pointer(), uintptr(slot)*slotLinkBytes))
}

func (s *Slots) heldRow(slot uint32) unsafe.Pointer {
	return unsafe.Add(s.heldLocks.Pointer(), uintptr(slot)*heldLockRowBytes)
}

func (s *Slots) committedSlots() uint32 {
	return uint32(s.pins.Committed() / pinEntryBytes)
}

func (s *Slots) commitThrough(count uint32) error {
	chunked := min(threadSlotCapacity, (count+threadSlotCommitChunk-1)/threadSlotCommitChunk*threadSlotCommitChunk)
	if s.committedSlots() >= chunked {
		return nil
	}
	for _, commit := range []struct {
		region *core.SharedRegion
		bytes  uintptr
	}{
		{s.links, uintptr(chunked) * slotLinkBytes},
		{s.heldLocks, uintptr(chunked) * heldLockRowBytes},
		{s.pins, uintptr(chunked) * pinEntryBytes},
	} {
		if err := commit.region.Commit(commit.bytes); err != nil {
			return regionFailure(err, commit.bytes, commit.bytes)
		}
	}
	return nil
}

func (s *Slots) take() (uint32, error) {
	for {
		head := s.free.Load()
		top := uint32(head & freeListSlotMask)
		if top == 0 {
			break
		}
		next := uint64(s.link(top - 1).Load())
		tag := (head>>freeListTagShift + 1) << freeListTagShift
		if s.free.CompareAndSwap(head, tag|next) {
			return top - 1, nil
		}
	}
	for {
		count := s.handedOut.Load()
		if count >= threadSlotCapacity {
			return 0, slotsExhausted()
		}
		if err := s.commitThrough(count + 1); err != nil {
			return 0, err
		}
		if s.handedOut.CompareAndSwap(count, count+1) {
			return count, nil
		}
	}
}

func (s *Slots) give(slot uint32) {
	for {
		head := s.free.Load()
		s.link(slot).Store(uint32(head & freeListSlotMask))
		tag := (head>>freeListTagShift + 1) << freeListTagShift
		if s.free.CompareAndSwap(head, tag|uint64(slot+1)) {
			return
		}
	}
}

func (s *Slots) pinSlot(slot uint32) int64 {
	entry := s.pinEntry(slot)
	for {
		seen := s.sequence.Load()
		if entry.Load() == 0 {
			entry.Store(seen + 1)
		}
		if s.sequence.Load() == seen {
			return seen
		}
	}
}

func (s *Slots) oldestPin() int64 {
	oldest := int64(noPinHeld)
	for slot := range s.handedOut.Load() {
		if entry := s.pinEntry(slot).Load(); entry != 0 && entry-1 < oldest {
			oldest = entry - 1
		}
	}
	return oldest
}

func slotsExhausted() error {
	return narsilerr.New(narsilerr.CodeWorkerBusy,
		"Every thread slot of the index is in use, so the operation was refused; retry it once a running search ends",
		map[string]any{"maxSearches": float64(MaxSearchThreadSlots), "maxWriters": float64(maxWriterThreadSlots)})
}

func searchesExhausted() error {
	return narsilerr.New(narsilerr.CodeWorkerBusy,
		"Every search slot of the index is in use, so the search was refused; retry it once a running search ends",
		map[string]any{"maxSearches": float64(MaxSearchThreadSlots)})
}

func writersExhausted() error {
	return narsilerr.New(narsilerr.CodeWorkerBusy,
		"Every writer slot of the index is in use, so the index holds no more vector fields or checkpoint reads at once",
		map[string]any{"maxWriters": float64(maxWriterThreadSlots)})
}

func (s *Slots) admit(counter *atomic.Int32, limit int32, refused func() error) (*Lease, error) {
	if counter.Add(1) > limit {
		counter.Add(-1)
		return nil, refused()
	}
	slot, err := s.take()
	if err != nil {
		counter.Add(-1)
		return nil, err
	}
	s.Retain()
	return &Lease{slots: s, slot: slot, counter: counter}, nil
}

func (s *Slots) AcquireSearch() (*Lease, error) {
	lease, err := s.admit(&s.searching, MaxSearchThreadSlots, searchesExhausted)
	if err != nil {
		return nil, err
	}
	lease.pin = s.pinSlot(lease.slot)
	return lease, nil
}

func (s *Slots) acquireWriter() (*Lease, error) {
	return s.admit(&s.writers, maxWriterThreadSlots, writersExhausted)
}
