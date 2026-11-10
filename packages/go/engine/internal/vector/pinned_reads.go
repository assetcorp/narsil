package vector

import "context"

func (f *Field) leaseOf(ctx context.Context) (*Lease, bool) {
	lease, held := ctx.Value(leaseKey{}).(*Lease)
	if !held || lease == nil || lease.slots != f.slots || lease.released.Load() {
		return nil, false
	}
	return lease, true
}

func (f *Field) ordinalToRead(ctx context.Context, store *storeMemory, docID string) (int32, bool) {
	if lease, pinned := f.leaseOf(ctx); pinned {
		return store.admittedOrdinalOf(docID, lease.pin)
	}
	ordinal, held := store.ordinalOf(docID)
	return ordinal, held && liveOrdinal(store, ordinal)
}

func (f *Field) GetVector(docID string) ([]float32, bool) {
	return f.GetVectorUnder(context.Background(), docID)
}

func (f *Field) GetVectorUnder(ctx context.Context, docID string) ([]float32, bool) {
	for hold := f.coldHoldNow(); hold != nil; hold = f.coldHoldNow() {
		values, held := f.coldVectorOf(hold, docID)
		if f.coldHoldNow() == hold {
			return values, held
		}
	}
	if err := f.ensureFilesOpen(); err != nil {
		return nil, false
	}
	current := f.acquireLayout()
	if current == nil {
		return nil, false
	}
	defer current.done()
	store := current.store
	ordinal, held := f.ordinalToRead(ctx, store, docID)
	if !held || !store.holdsVector(ordinal) {
		return nil, false
	}
	values := make([]float32, store.dimension)
	if !store.readStoredVector(current.tables, ordinal, values) {
		return nil, false
	}
	return values, true
}
