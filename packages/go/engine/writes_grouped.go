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

func (n *Narsil) currentIndexOf(entry *indexEntry, indexName string) *index.Index {
	if entry != nil {
		return entry.index()
	}
	if held, found := n.lookup(indexName); found {
		return held.index()
	}
	return nil
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
	write.outcome.fail(refused, err)
	for at := start + 1; at < len(write.bounds.bounds); at++ {
		docID := write.idOf(at)
		write.outcome.fail(docID, memory.RefusedAfter(write.indexName, docID, refused))
	}
}

func (write groupedWrite) failFrom(start int, err error) {
	for at := start; at < len(write.bounds.bounds); at++ {
		write.outcome.fail(write.idOf(at), err)
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
	write := groupedWrite{indexName: holder.name, bounds: boundsOf(entry, documents),
		idOf: providedDocIDAt(documents), outcome: outcome}
	write.apply = func(start, end int) (bool, error) {
		var err error
		entry, release, err = n.insertChunk(ctx, holder, entry, release, documents[start:end], outcome)
		if err != nil {
			return false, err
		}
		if refusal := outcome.memoryRefusal; refusal != nil {
			write.failFrom(end, refusal)
			return false, nil
		}
		return true, nil
	}
	err := n.writeInGroups(ctx, func() *index.Index { return n.currentIndexOf(entry, holder.name) }, write)
	return entry, release, err
}

func isMemoryRefusal(err error) bool {
	return narsilerr.CodeOf(err) == narsilerr.CodeMemoryWriteBlocked
}

func (n *Narsil) updateInGroups(ctx context.Context, holder indexHolder, entry *indexEntry, release func(),
	updates []model.DocumentUpdate, outcome *batchOutcome) (*indexEntry, func(), error) {
	documents := make([]*model.Document, len(updates))
	for at, update := range updates {
		documents[at] = update.Document
	}
	write := groupedWrite{indexName: holder.name, bounds: boundsOf(entry, documents),
		idOf: func(at int) string { return updates[at].DocID }, outcome: outcome}
	write.apply = func(start, end int) (bool, error) {
		for at := start; at < end; at++ {
			if err := ctx.Err(); err != nil {
				return false, err
			}
			var err error
			entry, release, err = n.updateOne(ctx, holder, entry, release, updates[at], outcome.touched)
			switch {
			case err == nil:
				outcome.result.Succeeded = append(outcome.result.Succeeded, updates[at].DocID)
			case entry == nil || !isPerDocument(err):
				return false, err
			case isMemoryRefusal(err):
				write.failFrom(at, err)
				return false, nil
			default:
				outcome.fail(updates[at].DocID, err)
			}
		}
		return true, nil
	}
	err := n.writeInGroups(ctx, func() *index.Index { return n.currentIndexOf(entry, holder.name) }, write)
	return entry, release, err
}
