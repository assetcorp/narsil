package engine

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/memory"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type heldEntry struct {
	entry   *indexEntry
	release func()
}

func (n *Narsil) insertPreparedGroups(ctx context.Context, holder indexHolder, entry *indexEntry, release func(),
	hooked hookedInserts, outcome *batchOutcome) (*indexEntry, func(), []*model.InsertContext, error) {
	documents := make([]*model.Document, len(hooked.working))
	for at, document := range hooked.working {
		if hooked.live[at] {
			documents[at] = document
		}
	}
	idOf := hooked.idAt
	failRange := func(from, to int, err error) { hooked.failRange(from, to, outcome, err) }
	held := &heldEntry{entry: entry, release: release}
	shape := entry.memoryShape()
	var bounds *documentBounds
	if err := n.boundGroups(holder, held, shape, func() error {
		bounds = boundsOf(shape, documents, idOf)
		return nil
	}); err != nil {
		failRange(0, len(documents), err)
		return held.entry, held.release, nil, err
	}
	write := groupedWrite{indexName: holder.name, bounds: bounds, idOf: idOf, outcome: outcome, failRange: failRange}
	var inserted []*model.InsertContext
	write.apply = func(start, end int) (bool, error) {
		pending := make([]pendingInsert, 0, end-start)
		for at := start; at < end; at++ {
			if err := ctx.Err(); err != nil {
				for _, insert := range pending {
					outcome.fail(insert.id, err)
				}
				failRange(at, end, err)
				return false, err
			}
			if err := hooked.refusals[at]; err != nil {
				outcome.fail(idOf(at), err)
				continue
			}
			prepared, err := held.entry.prepared(documents[at])
			if err != nil {
				outcome.fail(idOf(at), err)
				continue
			}
			prepared.DocumentID = idOf(at)
			pending = append(pending, pendingInsert{id: idOf(at), context: hooked.contexts[at], write: prepared})
		}
		if len(pending) > 0 {
			if err := n.memory.refuseWhileFull(holder.name); err != nil {
				write.refusePending(pending, end, err)
				return false, nil
			}
		}
		var accepted []*model.InsertContext
		var err error
		held.entry, held.release, accepted, err = n.applyInsertChunk(ctx, held.entry, held.release, pending, outcome)
		if isMemoryRefusal(err) {
			write.refusePending(pending, end, err)
			return false, nil
		}
		inserted = append(inserted, accepted...)
		return err == nil && held.entry != nil, err
	}
	err := n.writeInGroups(ctx, write, func(start int) (*memory.Reservation, error) {
		var reservation *memory.Reservation
		taking := held.entry
		err := n.boundGroups(holder, held, shape, func() error {
			var err error
			reservation, err = n.memory.takeGroup(holder.name, taking.index(), bounds, start, batchChunkSize)
			return err
		})
		if held.entry == nil && reservation != nil {
			reservation.Release()
			reservation = nil
		}
		return reservation, err
	})
	return held.entry, held.release, inserted, err
}

func (write groupedWrite) refusePending(pending []pendingInsert, end int, err error) {
	outcome := write.outcome
	outcome.memoryRefusal, outcome.refusedDocID = err, pending[0].id
	for at, insert := range pending {
		if at == 0 {
			outcome.fail(insert.id, err)
		} else {
			outcome.fail(insert.id, laterRefusal(write.indexName, insert.id, err, outcome.refusedDocID))
		}
	}
	for at := end; at < len(write.bounds.bounds); at++ {
		id := write.idOf(at)
		outcome.fail(id, laterRefusal(write.indexName, id, err, outcome.refusedDocID))
	}
}

func (n *Narsil) boundGroups(holder indexHolder, held *heldEntry, shape *memory.Shape, bound func() error) error {
	if !shape.CallsCallerCode() {
		return bound()
	}
	entry, release, err := n.boundOutsideTheIndex(holder, held.release, bound)
	held.entry, held.release = entry, release
	return err
}
