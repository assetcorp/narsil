package engine

import (
	"context"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
)

type vectorSource struct {
	fields map[string]*vector.Field
	names  []string
}

type vectorSearcher struct {
	field *vector.Field
}

func (source *vectorSource) VectorSearcher(field string) (index.VectorSearcher, bool) {
	found, held := source.fields[field]
	if !held {
		return nil, false
	}
	return vectorSearcher{field: found}, true
}

func (source *vectorSource) VectorFieldNames() []string {
	return append([]string(nil), source.names...)
}

func (searcher vectorSearcher) SearchVectors(ctx context.Context, request index.VectorRequest) (index.VectorOutcome, error) {
	config := request.Config
	if config == nil {
		return index.VectorOutcome{}, narsilerr.New(narsilerr.CodeConfigInvalid, "A vector search needs a vector clause", nil)
	}
	options := vector.SearchOptions{
		Metric:        config.Metric,
		MinSimilarity: config.Similarity.Or(math.Inf(-1)),
		EfSearch:      config.EfSearch.Or(0),
		Oversample:    config.Oversample.Or(0),
		RescoreWindow: request.RescoreWindow,
	}
	if options.Metric == "" {
		options.Metric = model.MetricCosine
	}
	if request.Filtered {
		options.Filter = vector.AcceptDocIDs(request.AcceptedIDs)
	}
	outcome, err := searcher.field.Search(ctx, config.Value, request.K, options)
	if err != nil {
		return index.VectorOutcome{}, err
	}
	hits := make([]index.VectorHit, len(outcome.Results))
	for at, result := range outcome.Results {
		hits[at] = index.VectorHit{ID: result.DocID, Score: result.Score}
	}
	return index.VectorOutcome{Hits: hits, Matched: outcome.Matched, MatchedExact: outcome.MatchedExact}, nil
}

func (entry *indexEntry) selectVectorFields(fieldName string) ([]*vector.Field, error) {
	if fieldName == "" {
		fields := make([]*vector.Field, 0, len(entry.vectorPaths))
		for _, path := range entry.vectorPaths {
			fields = append(fields, entry.handle.Vectors[path])
		}
		return fields, nil
	}
	field, found := entry.handle.Vectors[fieldName]
	if !found {
		return nil, narsilerr.New(narsilerr.CodeIndexNotFound,
			`Vector field "`+fieldName+`" not found in index "`+entry.name+`"`,
			map[string]any{"indexName": entry.name, "fieldName": fieldName})
	}
	return []*vector.Field{field}, nil
}

// CompactVectors rebuilds the vector storage of one field, or of every
// vector field when fieldName is empty, so that the space that removed
// vectors held is freed. It returns CodeIndexNotFound when the index
// declares no vector field of that name.
func (n *Narsil) CompactVectors(ctx context.Context, indexName string, fieldName string) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	fields, err := entry.selectVectorFields(fieldName)
	if err != nil {
		return err
	}
	entry.writeMu.Lock()
	defer entry.writeMu.Unlock()
	defer n.emitWrite(indexName)
	for _, field := range fields {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := field.Compact(); err != nil {
			return err
		}
	}
	return nil
}

// OptimizeVectors builds the search graph of one vector field, or of every
// vector field when fieldName is empty, and returns once the graph is ready,
// so that the next vector query searches the graph and skips the full scan.
// The context bounds the build.
func (n *Narsil) OptimizeVectors(ctx context.Context, indexName string, fieldName string) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	fields, err := entry.selectVectorFields(fieldName)
	if err != nil {
		return err
	}
	defer n.emitWrite(indexName)
	for _, field := range fields {
		if err := field.Optimize(ctx); err != nil {
			return err
		}
	}
	return nil
}

// VectorMaintenanceStatus returns the state of each vector field's search
// graph in the index, in field order.
func (n *Narsil) VectorMaintenanceStatus(indexName string) ([]VectorMaintenanceResult, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return nil, err
	}
	defer release()
	results := make([]model.VectorMaintenanceResult, 0, len(entry.vectorPaths))
	for _, path := range entry.vectorPaths {
		results = append(results, entry.handle.Vectors[path].MaintenanceStatus())
	}
	return results, nil
}
