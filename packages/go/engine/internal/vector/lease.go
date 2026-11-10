package vector

import (
	"context"
	"sync/atomic"
	"unsafe"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

const (
	heldWordWritersWaiting = 4
	lockWordWriteHeld      = 1
	lockWordWriterWaiting  = 2
	lockWordVersionStep    = 4
)

type Lease struct {
	slots    *Slots
	slot     uint32
	pin      int64
	counter  *atomic.Int32
	graph    *graphMemory
	inUse    atomic.Bool
	released atomic.Bool
}

func (l *Lease) Pin() int64 {
	return l.pin
}

func (l *Lease) Release() {
	if l == nil || !l.released.CompareAndSwap(false, true) {
		return
	}
	l.leave()
	l.slots.pinEntry(l.slot).Store(0)
	l.slots.give(l.slot)
	l.counter.Add(-1)
	l.slots.resource.drop()
}

func (l *Lease) pinNow() {
	l.pin = l.slots.pinSlot(l.slot)
}

func (l *Lease) unpin() {
	l.slots.pinEntry(l.slot).Store(0)
}

func (l *Lease) enter(graph *graphMemory) {
	l.graph = graph
}

func (l *Lease) leave() {
	graph := l.graph
	l.graph = nil
	if graph != nil {
		releaseHeldLocks(graph, l.slots.heldRow(l.slot))
	}
}

func releaseHeldLocks(graph *graphMemory, row unsafe.Pointer) {
	word := func(index int) *atomic.Int32 { return int32Word(row, index) }
	if node := word(core.HeldWordNode).Swap(0); node > 0 {
		value := word(core.HeldWordNodeValue).Swap(0)
		if ordinal := uintptr(node - 1); ordinal*4 < graph.locks.length {
			released := value&^(lockWordWriteHeld|lockWordWriterWaiting) + lockWordVersionStep
			int32Word(graph.locks.pointer(), int(ordinal)).CompareAndSwap(value, released)
		}
	}
	if word(core.HeldWordGraph).Swap(0) == 1 {
		graph.word(core.GraphWordLock).Add(-1)
	}
	if word(heldWordWritersWaiting).Swap(0) == 1 {
		graph.word(core.GraphWordWritersWaiting).Add(-1)
	}
	if word(core.HeldWordEntry).Swap(0) == 1 {
		graph.word(core.GraphWordEntryLock).Store(0)
	}
}

type leaseKey struct{}

func WithLease(ctx context.Context, lease *Lease) context.Context {
	return context.WithValue(ctx, leaseKey{}, lease)
}

func (s *Slots) searchLease(ctx context.Context) (*Lease, func(), error) {
	if shared, held := s.PinnedLease(ctx); held {
		if shared.inUse.CompareAndSwap(false, true) {
			return shared, func() { shared.leave(); shared.inUse.Store(false) }, nil
		}
		own, err := s.admit(&s.searching, MaxSearchThreadSlots, searchesExhausted)
		if err != nil {
			return nil, nil, err
		}
		own.pin = shared.pin
		own.slots.pinEntry(own.slot).Store(shared.pin + 1)
		return own, own.Release, nil
	}
	own, err := s.AcquireSearch()
	if err != nil {
		return nil, nil, err
	}
	return own, own.Release, nil
}
