package vector

import (
	"sync/atomic"
)

type coldWrittenStore struct {
	store   *storeMemory
	slots   *Slots
	current atomic.Pointer[layout]
}

func newColdWrittenStore(dimension int, blockBytes uintptr) (*coldWrittenStore, error) {
	slots, err := NewSlots()
	if err != nil {
		return nil, err
	}
	store, err := newStoreMemory(dimension, 0, blockBytes, slots)
	if err != nil {
		slots.Close()
		return nil, err
	}
	return &coldWrittenStore{store: store, slots: slots}, nil
}

func (w *coldWrittenStore) publish() error {
	next, err := buildLayout(w.store, nil)
	if err != nil {
		return err
	}
	if previous := w.current.Swap(next); previous != nil {
		previous.retire()
	}
	return nil
}

func (w *coldWrittenStore) insert(docID string, values []float32) (int32, int64, error) {
	var ordinal int32
	var written int64
	err := w.slots.Write(func(sequence int64) error {
		var err error
		ordinal, _, err = w.store.insert(docID, values, PartitionUnknown, sequence)
		written = sequence
		return err
	})
	if err != nil {
		return 0, 0, err
	}
	return ordinal, written, w.publish()
}

func (w *coldWrittenStore) remove(docID string) int64 {
	var removed int64
	_ = w.slots.Write(func(sequence int64) error {
		removed = sequence
		if ordinal, held := w.store.ordinalOf(docID); held {
			w.store.byDocID.Delete(docID)
			w.store.stampRetired(ordinal, sequence)
		}
		return nil
	})
	return removed
}

func (w *coldWrittenStore) acquire() *layout {
	for {
		current := w.current.Load()
		if current == nil {
			return nil
		}
		if current.acquire() {
			return current
		}
	}
}

func (w *coldWrittenStore) close() {
	if previous := w.current.Swap(nil); previous != nil {
		previous.retire()
	}
	w.store.discard()
	w.slots.Close()
}
