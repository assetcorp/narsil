package vector

import (
	"context"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type layout struct {
	users    atomic.Int64
	retired  atomic.Bool
	released atomic.Bool
	store    *storeMemory
	head     *storeHead
	tables   *storeTables
	native   *core.Store
	graph    *graphMemory
	holds    []*sharedResource
	drained  chan struct{}
}

func (l *layout) word(index int) *atomic.Int32 {
	return int32Word(l.head.header.pointer(), index)
}

func (l *layout) searchesCodes() bool {
	return l.store.bits != 0 && l.word(core.StoreWordCalibrated).Load() == 1 && l.word(core.StoreWordCodeCount).Load() > 0
}

func (l *layout) acquire() bool {
	l.users.Add(1)
	if l.retired.Load() {
		l.done()
		return false
	}
	return true
}

func (l *layout) done() {
	if l.users.Add(-1) == 0 && l.retired.Load() {
		l.release()
	}
}

func (l *layout) retire() {
	l.retired.Store(true)
	if l.users.Load() == 0 {
		l.release()
	}
}

func (l *layout) release() {
	if !l.released.CompareAndSwap(false, true) {
		return
	}
	if l.native != nil {
		l.native.Retire()
	}
	for _, held := range l.holds {
		held.drop()
	}
	close(l.drained)
}

func buildLayout(store *storeMemory, graph *graphMemory) (*layout, error) {
	next := &layout{store: store, graph: graph, drained: make(chan struct{})}
	if store == nil {
		return next, nil
	}
	next.tables = store.tables
	next.head = store.head
	native, err := core.NewStore(store.nativeLayout(store.head, store.tables))
	if err != nil {
		return nil, coreFailure("attachStore", err)
	}
	next.native = native
	next.holds = append(next.holds, store.resource.retain(), store.head.resource.retain())
	for _, held := range store.tables.resources() {
		next.holds = append(next.holds, held.retain())
	}
	if graph != nil {
		next.holds = append(next.holds, graph.resource.retain())
	}
	return next, nil
}

func (f *Field) acquireLayout() *layout {
	for {
		current := f.current.Load()
		if current == nil {
			return nil
		}
		if current.acquire() {
			return current
		}
	}
}

func (f *Field) publish(store *storeMemory, graph *graphMemory) error {
	next, err := buildLayout(store, graph)
	if err != nil {
		return err
	}
	previous := f.current.Swap(next)
	if previous != nil {
		previous.retire()
	}
	return nil
}

func (f *Field) writerLayout() *layout {
	return f.current.Load()
}

func (f *Field) publishAndDrain(ctx context.Context) error {
	previous := f.current.Load()
	if err := f.publish(f.store, f.graph); err != nil {
		return err
	}
	if previous == nil {
		return nil
	}
	select {
	case <-previous.drained:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
