package engine

import (
	"context"
	"fmt"
	"math"
	"reflect"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type boundAdapter struct {
	adapter model.EmbeddingAdapter
	entry   *indexEntry
	binding uint64
}

func (bound boundAdapter) fits(entry *indexEntry) bool {
	current, binding := entry.boundEmbedderWithBinding()
	if entry == bound.entry && binding == bound.binding {
		return true
	}
	return sameEmbedder(bound.adapter, current)
}

type queryEmbedding struct {
	boundAdapter
	params     model.QueryParams
	embeddings int
	superseded bool
}

func (embedded *queryEmbedding) fits(entry *indexEntry) bool {
	if embedded.adapter == nil {
		return true
	}
	return embedded.boundAdapter.fits(entry)
}

func sameEmbedder(used, current model.EmbeddingAdapter) (same bool) {
	if current == nil {
		return false
	}
	kind := reflect.TypeOf(used)
	if kind != reflect.TypeOf(current) || !kind.Comparable() {
		return false
	}
	defer func() {
		if recover() != nil {
			same = false
		}
	}()
	return used == current
}

func (entry *indexEntry) queryEmbedderFor(params model.QueryParams) (model.EmbeddingAdapter, uint64, error) {
	vector := params.Vector
	if vector == nil {
		return nil, 0, nil
	}
	text, hasText := vector.Text.Get()
	if !hasText {
		return nil, 0, nil
	}
	if vector.Value != nil {
		return nil, 0, narsilerr.New(narsilerr.CodeEmbeddingConfigInvalid, "Vector query cannot have both 'text' and 'value'", nil)
	}
	adapter, binding := entry.boundEmbedderWithBinding()
	if adapter == nil {
		if entry.embeddingName != "" {
			return nil, 0, narsilerr.New(narsilerr.CodeEmbeddingConfigInvalid,
				fmt.Sprintf("Vector query with 'text' needs embedding adapter %q, which is not registered on this engine. Register it with RegisterEmbeddingAdapter or supply a raw vector.", entry.embeddingName),
				map[string]any{"adapter": entry.embeddingName})
		}
		return nil, 0, narsilerr.New(narsilerr.CodeEmbeddingConfigInvalid,
			"Vector query with 'text' requires an embedding adapter on the index or instance", nil)
	}
	if text == "" {
		return nil, 0, narsilerr.New(narsilerr.CodeDocValidationFailed, "Vector query 'text' must not be empty", nil)
	}
	return adapter, binding, nil
}

func embedQueryText(ctx context.Context, adapter model.EmbeddingAdapter, params model.QueryParams) (model.QueryParams, error) {
	vector := params.Vector
	text, _ := vector.Text.Get()
	embedder := safeEmbedder{adapter: adapter}
	raw, err := embedder.Embed(ctx, text, model.EmbeddingForQuery)
	if err != nil {
		if _, isEngineError := narsilerr.As(err); isEngineError {
			return params, err
		}
		return params, narsilerr.New(narsilerr.CodeEmbeddingFailed,
			"The embedding adapter cannot embed the query: "+err.Error(), map[string]any{"cause": err.Error()})
	}
	if raw == nil {
		return params, narsilerr.New(narsilerr.CodeEmbeddingFailed,
			"Adapter returned undefined for query embedding, expected Float32Array", nil)
	}
	dimensions := embedder.Dimensions()
	if len(raw) != dimensions {
		return params, narsilerr.New(narsilerr.CodeEmbeddingDimensionMismatch,
			fmt.Sprintf("Adapter returned %d-dimensional vector for query, expected %d", len(raw), dimensions),
			map[string]any{"expected": dimensions, "actual": len(raw)})
	}
	for at, value := range raw {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return params, narsilerr.New(narsilerr.CodeEmbeddingFailed,
				fmt.Sprintf("Adapter returned vector with %s at index %d for query embedding", formatNonFinite(value), at),
				map[string]any{"index": at})
		}
	}
	resolved := *vector
	resolved.Value = append([]float32(nil), raw...)
	resolved.Text = model.Optional[string]{}
	params.Vector = &resolved
	return params, nil
}

func queryAdapterKeptChanging(indexName string, embeddings int) error {
	return narsilerr.New(narsilerr.CodeWorkerBusy,
		fmt.Sprintf("The embedding adapter of index %q changed after each of %d query embeddings", indexName, embeddings),
		map[string]any{"indexName": indexName, "embeddings": embeddings})
}

func (n *Narsil) embedForQuery(ctx context.Context, indexName string, entry *indexEntry, release func(),
	params model.QueryParams, earlier *queryEmbedding) (*indexEntry, func(), queryEmbedding, error) {
	for {
		embeddings := 0
		if earlier != nil {
			if !earlier.superseded && earlier.fits(entry) {
				return entry, release, *earlier, nil
			}
			embeddings = earlier.embeddings
		}
		if embeddings >= maxCallsAcrossIndexChanges {
			release()
			return nil, nil, queryEmbedding{}, queryAdapterKeptChanging(indexName, embeddings)
		}
		adapter, binding, err := entry.queryEmbedderFor(params)
		if err != nil {
			release()
			return nil, nil, queryEmbedding{}, err
		}
		if adapter == nil {
			return entry, release, queryEmbedding{params: params}, nil
		}
		release()
		resolved, err := embedQueryText(ctx, adapter, params)
		if err != nil {
			return nil, nil, queryEmbedding{}, err
		}
		embedded := queryEmbedding{boundAdapter: boundAdapter{adapter: adapter, entry: entry, binding: binding},
			params: resolved, embeddings: embeddings + 1}
		if entry, release, err = n.acquire(indexName); err != nil {
			return nil, nil, queryEmbedding{}, err
		}
		if embedded.fits(entry) {
			return entry, release, embedded, nil
		}
		embedded.superseded = true
		earlier = &embedded
	}
}
