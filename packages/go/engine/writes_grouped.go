package engine

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/memory"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type groupedWrite struct {
	indexName string
	bounds    *documentBounds
	idOf      func(at int) string
	outcome   *batchOutcome
	apply     func(start, end int) (bool, error)
}

func (n *Narsil) applyGroup(write groupedWrite, reservation *memory.Reservation, start int) (bool, error) {
	defer reservation.Release()
	return write.apply(start, start+reservation.Count)
}

func (n *Narsil) writeInGroups(ctx context.Context, current func() *index.Index, write groupedWrite) error {
	total := len(write.bounds.bounds)
	for start := 0; start < total; {
		if err := ctx.Err(); err != nil {
			return err
		}
		reservation, err := n.memory.takeGroup(write.indexName, current(), write.bounds, start, batchChunkSize)
		if err != nil {
			write.refuseFrom(start, err)
			return nil
		}
		proceed, err := n.applyGroup(write, reservation, start)
		if err != nil || !proceed {
			return err
		}
		start += reservation.Count
	}
	return nil
}

func (write groupedWrite) refuseFrom(start int, err error) {
	refused := write.idOf(start)
	write.outcome.memoryRefusal = err
	write.outcome.refusedDocID = refused
	write.outcome.fail(refused, err)
	for at := start + 1; at < len(write.bounds.bounds); at++ {
		docID := write.idOf(at)
		write.outcome.fail(docID, memory.RefusedAfter(write.indexName, docID, refused))
	}
}

func providedDocIDAt(documents []*model.Document) func(at int) string {
	return func(at int) string {
		id, _ := schema.ProvidedDocID(documents[at])
		return id
	}
}

func (n *Narsil) insertInGroups(ctx context.Context, holder indexHolder, entry *indexEntry, release func(),
	documents []*model.Document, outcome *batchOutcome) (*indexEntry, func(), error) {
	idOf := providedDocIDAt(documents)
	for start := 0; start < len(documents); start += batchChunkSize {
		if err := ctx.Err(); err != nil {
			return entry, release, err
		}
		end := min(start+batchChunkSize, len(documents))
		var err error
		entry, release, err = n.insertChunk(ctx, holder, entry, release, documents[start:end], outcome)
		if err != nil {
			return entry, release, err
		}
		if outcome.memoryRefusal != nil {
			for at := end; at < len(documents); at++ {
				id := idOf(at)
				outcome.fail(id, memory.RefusedAfter(holder.name, id, outcome.refusedDocID))
			}
			break
		}
	}
	return entry, release, nil
}

func isMemoryRefusal(err error) bool {
	return narsilerr.CodeOf(err) == narsilerr.CodeMemoryWriteBlocked
}

func (n *Narsil) updateInGroups(ctx context.Context, holder indexHolder, entry *indexEntry, release func(),
	updates []model.DocumentUpdate, outcome *batchOutcome) (*indexEntry, func(), error) {
	for at, update := range updates {
		if err := ctx.Err(); err != nil {
			return entry, release, err
		}
		var err error
		entry, release, err = n.updateOne(ctx, holder, entry, release, update, outcome.touched)
		switch {
		case err == nil:
			outcome.result.Succeeded = append(outcome.result.Succeeded, update.DocID)
		case entry == nil || !isPerDocument(err):
			return entry, release, err
		case isMemoryRefusal(err):
			outcome.fail(update.DocID, err)
			for _, later := range updates[at+1:] {
				outcome.fail(later.DocID, memory.RefusedAfter(holder.name, later.DocID, update.DocID))
			}
			return entry, release, nil
		default:
			outcome.fail(update.DocID, err)
		}
	}
	return entry, release, nil
}
