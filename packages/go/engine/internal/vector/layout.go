package vector

import (
	"context"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type layout struct {
	users   publicationHolds
	store   *storeMemory
	head    *storeHead
	tables  *storeTables
	native  *core.Store
	graph   *graphMemory
	holds   []*sharedResource
	drained chan struct{}
}

func (l *layout) word(index int) *atomic.Int32 {
	return int32Word(l.head.header.pointer(), index)
}

func (l *layout) searchesCodes() bool {
	return l.store.bits != 0 && l.word(core.StoreWordCalibrated).Load() == 1 && l.word(core.StoreWordCodeCount).Load() > 0
}

func (l *layout) acquire() bool {
	return l.users.hold()
}

func (l *layout) done() {
	l.users.drop()
}

func (l *layout) retire() {
	l.users.retire()
}

func (l *layout) release() {
	if l.native != nil {
		l.native.Free()
	}
	for _, held := range l.holds {
		held.drop()
	}
	close(l.drained)
}

func buildLayout(store *storeMemory, graph *graphMemory) (*layout, error) {
	next := &layout{store: store, graph: graph, drained: make(chan struct{})}
	next.users.publish(next.release)
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
	next.holds = append(next.holds, store.resource.retain(), store.head.resource.retain(),
		store.slotTable.resource.retain())
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

func (f *Field) layoutPublishedBy(held *layout) *layout {
	if f.current.Load() == held {
		return held
	}
	fresh := f.acquireLayout()
	held.done()
	return fresh
}

func (f *Field) publish(store *storeMemory, graph *graphMemory) error {
	next, err := buildLayout(store, graph)
	if err != nil {
		return err
	}
	previous := f.current.Swap(next)
	if previous != nil {
		previous.retire()
		if previous.tables != nil && len(previous.tables.files) > 0 {
			f.retiredFileLayouts = append(f.fileLayoutsInUse(), previous)
		}
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
	for _, retired := range f.fileLayoutsInUse() {
		select {
		case <-retired.drained:
		case <-ctx.Done():
			return ctx.Err()
		}
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

func (f *Field) fileLayoutsInUse() []*layout {
	held := f.retiredFileLayouts[:0]
	for _, retired := range f.retiredFileLayouts {
		select {
		case <-retired.drained:
		default:
			held = append(held, retired)
		}
	}
	clear(f.retiredFileLayouts[len(held):])
	f.retiredFileLayouts = held
	return held
}
