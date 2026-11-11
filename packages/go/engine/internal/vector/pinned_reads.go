package vector

import "context"

func (s *Slots) PinnedLease(ctx context.Context) (*Lease, bool) {
	lease, held := ctx.Value(leaseKey{}).(*Lease)
	if !held || lease == nil || lease.slots != s || lease.released.Load() {
		return nil, false
	}
	return lease, true
}

func (f *Field) ordinalToRead(ctx context.Context, store *storeMemory, docID string) (int32, bool) {
	if lease, pinned := f.slots.PinnedLease(ctx); pinned {
		return store.admittedOrdinalOf(docID, lease.pin)
	}
	ordinal, held := store.ordinalOf(docID)
	return ordinal, held && liveOrdinal(store, ordinal)
}

func (f *Field) GetVector(docID string) ([]float32, bool, error) {
	return f.GetVectorUnder(context.Background(), docID)
}

func (f *Field) GetVectorUnder(ctx context.Context, docID string) ([]float32, bool, error) {
	for hold := f.coldHoldNow(); hold != nil; hold = f.coldHoldNow() {
		if failure := hold.replayFailure(); failure != nil {
			return nil, false, failure
		}
		values, held, err := f.coldVectorOf(ctx, hold, docID)
		if failure := hold.replayFailure(); failure != nil {
			return nil, false, failure
		}
		if f.coldHoldNow() == hold {
			return values, held, err
		}
	}
	if err := f.ensureFilesOpen(); err != nil {
		return nil, false, err
	}
	current := f.acquireLayout()
	if current == nil {
		return nil, false, nil
	}
	defer current.done()
	store := current.store
	ordinal, held := f.ordinalToRead(ctx, store, docID)
	if !held || !store.holdsVector(ordinal) {
		return nil, false, nil
	}
	values := make([]float32, store.dimension)
	if !store.readStoredVector(current.tables, ordinal, values) {
		return nil, false, nil
	}
	return values, true, nil
}
