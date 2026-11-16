package engine

import (
	"context"

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
	failRange func(from, to int, err error)
}

func (n *Narsil) applyGroup(write groupedWrite, reservation *memory.Reservation, start int) (bool, error) {
	defer reservation.Release()
	return write.apply(start, start+reservation.Count)
}

func (n *Narsil) writeInGroups(ctx context.Context, write groupedWrite,
	take func(start int) (*memory.Reservation, error)) error {
	total := len(write.bounds.bounds)
	for start := 0; start < total; {
		if err := ctx.Err(); err != nil {
			write.failRange(start, total, err)
			return err
		}
		reservation, err := take(start)
		if err != nil && !isMemoryRefusal(err) {
			write.failRange(start, total, err)
			return err
		}
		if err != nil {
			write.refuseFrom(start, err)
			return nil
		}
		end := start + reservation.Count
		proceed, err := n.applyGroup(write, reservation, start)
		if err != nil {
			write.failRange(end, total, err)
			return err
		}
		if !proceed {
			return nil
		}
		start = end
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
	failFrom := func(from int, err error) {
		for at := from; at < len(documents); at++ {
			outcome.fail(idOf(at), err)
		}
	}
	for start := 0; start < len(documents); start += batchChunkSize {
		if err := ctx.Err(); err != nil {
			failFrom(start, err)
			return entry, release, err
		}
		end := min(start+batchChunkSize, len(documents))
		var err error
		entry, release, err = n.insertChunk(ctx, holder, entry, release, documents[start:end], outcome)
		if err != nil {
			failFrom(end, err)
			return entry, release, err
		}
		if outcome.memoryRefusal != nil {
			for at := end; at < len(documents); at++ {
				id := idOf(at)
				outcome.fail(id, laterRefusal(holder.name, id, outcome.memoryRefusal, outcome.refusedDocID))
			}
			break
		}
	}
	return entry, release, nil
}

func isMemoryRefusal(err error) bool {
	return narsilerr.CodeOf(err) == narsilerr.CodeMemoryWriteBlocked
}

func laterRefusal(indexName, docID string, refusal error, refusedDocID string) error {
	if memory.IsMemoryFull(refusal) {
		return refusal
	}
	return memory.RefusedAfter(indexName, docID, refusedDocID)
}

func (n *Narsil) updateInGroups(ctx context.Context, holder indexHolder, entry *indexEntry, release func(),
	updates []model.DocumentUpdate, outcome *batchOutcome) (*indexEntry, func(), error) {
	failFrom := func(from int, err error) {
		for _, later := range updates[from:] {
			outcome.fail(later.DocID, err)
		}
	}
	for at, update := range updates {
		if err := ctx.Err(); err != nil {
			failFrom(at, err)
			return entry, release, err
		}
		var err error
		entry, release, err = n.updateOne(ctx, holder, entry, release, update, outcome.touched)
		switch {
		case err == nil:
			outcome.result.Succeeded = append(outcome.result.Succeeded, update.DocID)
		case entry == nil || !isPerDocument(err):
			failFrom(at, err)
			return entry, release, err
		case isMemoryRefusal(err):
			outcome.fail(update.DocID, err)
			for _, later := range updates[at+1:] {
				outcome.fail(later.DocID, laterRefusal(holder.name, later.DocID, err, update.DocID))
			}
			return entry, release, nil
		default:
			outcome.fail(update.DocID, err)
		}
	}
	return entry, release, nil
}
