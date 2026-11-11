package engine

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (entry *indexEntry) attachVectorsUnder(ctx context.Context, document *model.Document, id string,
	shown projection.Projection) error {
	if len(entry.vectorPaths) == 0 || document == nil {
		return nil
	}
	return shown.CopyVectorsInto(document, entry.vectorPaths, func(path string) ([]float32, bool, error) {
		return entry.handle.Vectors[path].GetVectorUnder(ctx, id)
	})
}

func (entry *indexEntry) storedDocument(ctx context.Context, id string) (*model.Document, bool, error) {
	ix := entry.index()
	pinned, unpin, err := ix.Pin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer unpin()
	document, found, err := ix.GetProjected(pinned, id, model.DocumentProjection{})
	if err != nil || !found {
		return nil, false, err
	}
	if err := entry.attachVectorsUnder(pinned, document, id, projection.Resolve(model.DocumentProjection{})); err != nil {
		return nil, false, err
	}
	return document, true, nil
}

// Get returns the document stored under docID in the index called indexName,
// with its vectors, and nil and false when no document holds that ID. The
// document holds its own copy of the stored bytes, so it stays readable
// after later writes, a vacuum, a compaction, and Close, and a change to it
// reaches the index only through Update. It returns
// CodePersistenceLoadFailed when the stored bytes of the document do not
// decode.
func (n *Narsil) Get(ctx context.Context, indexName string, docID string) (*Document, bool, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return nil, false, err
	}
	defer release()
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	return entry.storedDocument(ctx, docID)
}

// GetMultiple returns each stored document among docIDs as Get returns it,
// keyed by ID; an ID that holds no document is absent from the map.
func (n *Narsil) GetMultiple(ctx context.Context, indexName string, docIDs []string) (map[string]*Document, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return nil, err
	}
	defer release()
	pinned, unpin, err := entry.index().Pin(ctx)
	if err != nil {
		return nil, err
	}
	defer unpin()
	found := make(map[string]*model.Document, len(docIDs))
	for _, id := range docIDs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		document, held, err := entry.storedDocument(pinned, id)
		if err != nil {
			return nil, err
		}
		if held {
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
	if err := ctx.Err(); err != nil {
		return false, err
	}
	return entry.index().Has(ctx, docID)
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
	pinned, unpin, err := entry.index().Pin(ctx)
	if err != nil {
		return model.ListResult{}, err
	}
	defer unpin()
	result, err := entry.index().List(pinned, params)
	if err != nil {
		return model.ListResult{}, err
	}
	shown := projection.Resolve(params.Document)
	for _, listed := range result.Documents {
		if err := entry.attachVectorsUnder(pinned, listed.Document, listed.ID, shown); err != nil {
			return model.ListResult{}, err
		}
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
