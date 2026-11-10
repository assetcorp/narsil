package engine

import (
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type eventBus struct {
	mu        sync.RWMutex
	listeners map[uint64]model.EventHandlers
	next      uint64
}

func newEventBus(initial model.EventHandlers) *eventBus {
	bus := &eventBus{listeners: map[uint64]model.EventHandlers{}}
	bus.add(initial)
	return bus
}

func (bus *eventBus) add(handlers model.EventHandlers) func() {
	bus.mu.Lock()
	defer bus.mu.Unlock()
	id := bus.next
	bus.next++
	bus.listeners[id] = handlers
	var once sync.Once
	return func() {
		once.Do(func() {
			bus.mu.Lock()
			defer bus.mu.Unlock()
			delete(bus.listeners, id)
		})
	}
}

func (bus *eventBus) emit(event model.Event) int {
	bus.mu.RLock()
	ids := make([]uint64, 0, len(bus.listeners))
	handlers := make(map[uint64]model.EventHandlers, len(bus.listeners))
	for id, listener := range bus.listeners {
		ids = append(ids, id)
		handlers[id] = listener
	}
	bus.mu.RUnlock()
	sortIDs(ids)
	handled := 0
	for _, id := range ids {
		if dispatchSafely(handlers[id], event) {
			handled++
		}
	}
	return handled
}

func sortIDs(ids []uint64) {
	for at := 1; at < len(ids); at++ {
		for back := at; back > 0 && ids[back-1] > ids[back]; back-- {
			ids[back-1], ids[back] = ids[back], ids[back-1]
		}
	}
}

func dispatchSafely(handlers model.EventHandlers, event model.Event) (handled bool) {
	defer func() {
		if recover() != nil {
			handled = true
		}
	}()
	return handlers.Dispatch(event)
}

// On adds the listeners in handlers and returns a function that removes them
// again. Listeners run on the goroutine that raised the event, after the
// change that the event reports; a panic in a listener is recovered and
// dropped, so a listener can never fail an engine call. Calling the returned
// function more than once is safe.
func (n *Narsil) On(handlers EventHandlers) func() {
	return n.events.add(handlers)
}

func (n *Narsil) emitWrite(indexName string) {
	n.events.emit(model.WriteEvent{IndexName: indexName})
}
