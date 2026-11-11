package persist

import (
	"context"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
)

type heldDocuments map[string][]byte

func (handle *Handle) documentsBefore(ctx context.Context, group []Write) (heldDocuments, error) {
	held := make(heldDocuments, len(group))
	return held, handle.holdDocumentsBefore(ctx, held, group)
}

func (handle *Handle) holdDocumentsBefore(ctx context.Context, held heldDocuments, group []Write) error {
	pinned, unpin, err := handle.Index.Pin(ctx)
	if err != nil {
		return err
	}
	defer unpin()
	for _, write := range group {
		if _, seen := held[write.DocumentID]; seen {
			continue
		}
		body, err := handle.loggedDocumentOf(pinned, write.DocumentID)
		if err != nil {
			return err
		}
		held[write.DocumentID] = body
	}
	return nil
}

func (handle *Handle) loggedDocumentOf(ctx context.Context, id string) ([]byte, error) {
	stored, found, err := handle.Index.Get(ctx, id)
	if err != nil || !found {
		return nil, err
	}
	encoded, err := encodedDocument(stored.Document)
	if err != nil {
		return nil, err
	}
	vectors := map[string][]float32{}
	for path, field := range handle.Vectors {
		values, has, err := field.GetVectorUnder(ctx, id)
		if err != nil {
			return nil, err
		}
		if has {
			vectors[path] = values
		}
	}
	logged, err := storedWithVectors(encoded, vectors)
	if err != nil {
		return nil, err
	}
	return slices.Clone(logged), nil
}

func (handle *Handle) DetachedWriteOf(id string, logged []byte) (index.DocumentWrite, error) {
	write, err := writeOfEntry(wal.Entry{Operation: wal.OperationIndex, DocumentID: id, Document: logged},
		handle.vectorPaths())
	if err != nil {
		return index.DocumentWrite{}, err
	}
	return index.DocumentWrite{ID: id, Fields: write.Document, Encoded: write.Encoded}, nil
}

func (held heldDocuments) record(entry *wal.Entry) {
	if held == nil {
		return
	}
	body, found := held[entry.DocumentID]
	entry.Previous, entry.PreviousDocument = wal.PreviousDocumentNone, nil
	if found && body != nil {
		entry.Previous, entry.PreviousDocument = wal.PreviousDocumentHeld, body
	}
	held[entry.DocumentID] = entry.Document
}
