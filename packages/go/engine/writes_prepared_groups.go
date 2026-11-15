package engine

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/memory"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (n *Narsil) insertPreparedGroups(ctx context.Context, entry *indexEntry, hooked hookedInserts,
	outcome *batchOutcome) ([]*model.InsertContext, error) {
	documents := make([]*model.Document, len(hooked.working))
	for at, document := range hooked.working {
		if hooked.live[at] {
			documents[at] = document
		}
	}
	idOf := func(at int) string {
		if hooked.contexts[at] != nil {
			return hooked.contexts[at].DocID
		}
		return hooked.refusedAs[at]
	}
	write := groupedWrite{indexName: entry.name, bounds: boundsOf(entry, documents, idOf), idOf: idOf,
		outcome: outcome}
	var inserted []*model.InsertContext
	write.apply = func(start, end int) (bool, error) {
		pending := make([]pendingInsert, 0, end-start)
		for at := start; at < end; at++ {
			if err := ctx.Err(); err != nil {
				return false, err
			}
			if err := hooked.refusals[at]; err != nil {
				outcome.fail(idOf(at), err)
				continue
			}
			prepared, err := entry.prepared(documents[at])
			if err != nil {
				outcome.fail(idOf(at), err)
				continue
			}
			prepared.DocumentID = idOf(at)
			pending = append(pending, pendingInsert{id: idOf(at), context: hooked.contexts[at], write: prepared})
		}
		if len(pending) > 0 {
			if err := n.memory.refuseWhileFull(entry.name); err != nil {
				outcome.memoryRefusal, outcome.refusedDocID = err, pending[0].id
				for at, insert := range pending {
					if at == 0 {
						outcome.fail(insert.id, err)
					} else {
						outcome.fail(insert.id, memory.RefusedAfter(entry.name, insert.id, outcome.refusedDocID))
					}
				}
				for at := end; at < len(documents); at++ {
					outcome.fail(idOf(at), memory.RefusedAfter(entry.name, idOf(at), outcome.refusedDocID))
				}
				return false, nil
			}
		}
		accepted, err := n.applyInsertChunk(ctx, entry, pending, outcome)
		inserted = append(inserted, accepted...)
		return err == nil, err
	}
	err := n.writeInGroups(ctx, func() *index.Index { return entry.index() }, write)
	return inserted, err
}
