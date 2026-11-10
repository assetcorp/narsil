package engine

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (entry *indexEntry) attachVectors(document model.Document, id string, shown projection.Projection) {
	if len(entry.vectorPaths) == 0 || document == nil {
		return
	}
	shown.CopyVectorsInto(document, entry.vectorPaths, func(path string) ([]float32, bool) {
		return entry.handle.Vectors[path].GetVector(id)
	})
}

func (entry *indexEntry) storedDocument(id string) (model.Document, bool) {
	document, found := entry.index().GetProjected(id, model.DocumentProjection{})
	if !found {
		return nil, false
	}
	entry.attachVectors(document, id, projection.Resolve(model.DocumentProjection{}))
	return document, true
}

// Get returns a copy of the document stored under docID in the index called
// indexName, with its vectors, and false when no document holds that ID.
func (n *Narsil) Get(ctx context.Context, indexName string, docID string) (Document, bool, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return nil, false, err
	}
	defer release()
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	document, found := entry.storedDocument(docID)
	return document, found, nil
}

// GetMultiple returns a copy of each stored document among docIDs, keyed by
// ID; an ID that holds no document is absent from the map.
func (n *Narsil) GetMultiple(ctx context.Context, indexName string, docIDs []string) (map[string]Document, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return nil, err
	}
	defer release()
	found := make(map[string]model.Document, len(docIDs))
	for _, id := range docIDs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if document, held := entry.storedDocument(id); held {
			found[id] = document
		}
	}
	return found, nil
}

// Has reports whether the index called indexName holds a document under docID.
func (n *Narsil) Has(ctx context.Context, indexName string, docID string) (bool, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return false, err
	}
	defer release()
	return entry.index().Has(docID), ctx.Err()
}

// CountDocuments returns the number of documents in the index called indexName.
func (n *Narsil) CountDocuments(ctx context.Context, indexName string) (int, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return 0, err
	}
	defer release()
	return entry.index().Count(), ctx.Err()
}

// ListDocuments returns one page of the documents in the index called
// indexName that match params.Filters, in ID order or in params.Sort order,
// with the cursor that fetches the next page. Each document carries its
// vectors unless the projection drops them.
func (n *Narsil) ListDocuments(ctx context.Context, indexName string, params ListParams) (ListResult, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return model.ListResult{}, err
	}
	defer release()
	if err := ctx.Err(); err != nil {
		return model.ListResult{}, err
	}
	result, err := entry.index().List(params)
	if err != nil {
		return model.ListResult{}, err
	}
	shown := projection.Resolve(params.Document)
	for _, listed := range result.Documents {
		entry.attachVectors(listed.Document, listed.ID, shown)
	}
	return result, nil
}

// Suggest returns the indexed words that start with params.Prefix, most
// frequent first, with the number of documents that hold each one.
func (n *Narsil) Suggest(ctx context.Context, indexName string, params SuggestParams) (SuggestResult, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return model.SuggestResult{}, err
	}
	defer release()
	if err := ctx.Err(); err != nil {
		return model.SuggestResult{}, err
	}
	result, err := entry.index().Suggest(params)
	if err != nil {
		return model.SuggestResult{}, queryTokensRefused(err)
	}
	result.AnalysisStale = entry.analysisIsStale()
	return result, nil
}
