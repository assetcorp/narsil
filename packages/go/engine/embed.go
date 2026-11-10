package engine

import (
	"context"
	"fmt"
	"math"
	"strings"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type safeEmbedder struct {
	adapter model.EmbeddingAdapter
}

func (s safeEmbedder) Dimensions() (dimensions int) {
	defer func() {
		if recover() != nil {
			dimensions = 0
		}
	}()
	return s.adapter.Dimensions()
}

func (s safeEmbedder) Embed(ctx context.Context, input string, purpose model.EmbeddingPurpose) (vector []float32, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			vector, err = nil, fmt.Errorf("the adapter panicked: %v", recovered)
		}
	}()
	return s.adapter.Embed(ctx, input, purpose)
}

func (s safeEmbedder) embedBatch(ctx context.Context, inputs []string, purpose model.EmbeddingPurpose) (vectors [][]float32, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			vectors, err = nil, fmt.Errorf("the adapter panicked: %v", recovered)
		}
	}()
	if batch, batches := s.adapter.(model.BatchEmbeddingAdapter); batches {
		return batch.EmbedBatch(ctx, inputs, purpose)
	}
	vectors = make([][]float32, len(inputs))
	failures := make([]error, len(inputs))
	for start := 0; start < len(inputs); start += embeddingConcurrency {
		end := min(start+embeddingConcurrency, len(inputs))
		var group sync.WaitGroup
		for at := start; at < end; at++ {
			group.Add(1)
			go func(at int) {
				defer group.Done()
				vectors[at], failures[at] = s.Embed(ctx, inputs[at], purpose)
			}(at)
		}
		group.Wait()
		for _, failure := range failures[start:end] {
			if failure != nil {
				return nil, failure
			}
		}
	}
	return vectors, nil
}

func safeDimensions(adapter model.EmbeddingAdapter) int {
	return safeEmbedder{adapter: adapter}.Dimensions()
}

func resolvePath(document model.Document, path string) any {
	if !strings.Contains(path, ".") {
		return document[path]
	}
	var current any = document
	for _, segment := range strings.Split(path, ".") {
		holder, isMap := current.(map[string]any)
		if !isMap {
			return nil
		}
		current = holder[segment]
	}
	return current
}

func setPathCopying(document model.Document, path string, value any) {
	segments := strings.Split(path, ".")
	holder := document
	for _, segment := range segments[:len(segments)-1] {
		next, isMap := holder[segment].(map[string]any)
		copied := make(map[string]any, len(next)+1)
		if isMap {
			for key, held := range next {
				copied[key] = held
			}
		}
		holder[segment] = copied
		holder = copied
	}
	holder[segments[len(segments)-1]] = value
}

func shallowCopy(document model.Document) model.Document {
	copied := make(model.Document, len(document))
	for key, value := range document {
		copied[key] = value
	}
	return copied
}

func adapterFailure(err error, targetField string) error {
	if _, isEngineError := narsilerr.As(err); isEngineError {
		return err
	}
	return narsilerr.New(narsilerr.CodeEmbeddingFailed, fmt.Sprintf("Embedding failed for field %q: %s", targetField, err.Error()),
		map[string]any{"field": targetField, "cause": err.Error()})
}

func validateEmbedded(vector []float32, targetField string, dimensions int) error {
	if vector == nil {
		return narsilerr.New(narsilerr.CodeEmbeddingFailed,
			fmt.Sprintf("Adapter returned no vector for field %q, expected %d values", targetField, dimensions),
			map[string]any{"field": targetField, "returnedType": "undefined"})
	}
	if len(vector) != dimensions {
		return narsilerr.New(narsilerr.CodeEmbeddingDimensionMismatch,
			fmt.Sprintf("Adapter returned %d-dimensional vector for field %q, expected %d", len(vector), targetField, dimensions),
			map[string]any{"field": targetField, "expected": dimensions, "actual": len(vector)})
	}
	for at, value := range vector {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return narsilerr.New(narsilerr.CodeEmbeddingFailed,
				fmt.Sprintf("Adapter returned vector with %s at index %d for field %q", formatNonFinite(value), at, targetField),
				map[string]any{"field": targetField, "index": at})
		}
	}
	return nil
}

func formatNonFinite(value float32) string {
	switch {
	case math.IsNaN(float64(value)):
		return "NaN"
	case value > 0:
		return "Infinity"
	default:
		return "-Infinity"
	}
}

func collectSourceText(document model.Document, source model.EmbeddingSource, targetField string, documentIndex int) (string, error) {
	parts := make([]string, 0)
	for _, field := range source.Fields() {
		value := resolvePath(document, field)
		if value == nil || value == "" {
			continue
		}
		text, isText := value.(string)
		if !isText {
			return "", narsilerr.New(narsilerr.CodeDocValidationFailed,
				fmt.Sprintf("Embedding source field %q must be a string, got %s", field, typeNameOf(value)),
				map[string]any{"field": field, "targetField": targetField})
		}
		parts = append(parts, text)
	}
	if len(parts) == 0 {
		details := map[string]any{"field": targetField}
		if documentIndex >= 0 {
			details["documentIndex"] = documentIndex
		}
		return "", narsilerr.New(narsilerr.CodeEmbeddingNoSource,
			fmt.Sprintf("All source fields for embedding target %q are missing or empty", targetField), details)
	}
	return strings.Join(parts, "\n"), nil
}

func typeNameOf(value any) string {
	switch value.(type) {
	case bool:
		return "boolean"
	case float64, float32, int, int64, int32, uint, uint64, uint32:
		return "number"
	case string:
		return "string"
	default:
		return "object"
	}
}

func requireMappedVectors(document model.Document, config *model.EmbeddingFieldConfig, adapterName string) error {
	for _, target := range sortedNames(config.Fields) {
		if resolvePath(document, target) != nil {
			continue
		}
		if adapterName != "" {
			return narsilerr.New(narsilerr.CodeEmbeddingConfigInvalid,
				fmt.Sprintf("The index embeds %q via adapter %q, which is not registered on this engine. Register the adapter or supply the vector on the document.", target, adapterName),
				map[string]any{"field": target, "adapter": adapterName})
		}
		return narsilerr.New(narsilerr.CodeEmbeddingConfigInvalid,
			fmt.Sprintf("The index embeds %q automatically but no embedding adapter is bound. Bind an adapter or supply the vector on the document.", target),
			map[string]any{"field": target})
	}
	return nil
}

func embedDocument(ctx context.Context, document model.Document, config *model.EmbeddingFieldConfig, adapter model.EmbeddingAdapter) error {
	embedder := safeEmbedder{adapter: adapter}
	dimensions := embedder.Dimensions()
	for _, target := range sortedNames(config.Fields) {
		if resolvePath(document, target) != nil {
			continue
		}
		text, err := collectSourceText(document, config.Fields[target], target, -1)
		if err != nil {
			return err
		}
		vector, err := embedder.Embed(ctx, text, model.EmbeddingForDocument)
		if err != nil {
			return adapterFailure(err, target)
		}
		if err := validateEmbedded(vector, target, dimensions); err != nil {
			return err
		}
		setPathCopying(document, target, append([]float32(nil), vector...))
	}
	return nil
}

func isSourceFailure(err error) bool {
	code := narsilerr.CodeOf(err)
	return code == narsilerr.CodeEmbeddingNoSource || code == narsilerr.CodeDocValidationFailed
}

func embedBatch(ctx context.Context, documents []model.Document, live []bool, config *model.EmbeddingFieldConfig,
	adapter model.EmbeddingAdapter) (map[int]error, error) {
	embedder := safeEmbedder{adapter: adapter}
	dimensions := embedder.Dimensions()
	failed := map[int]error{}
	for _, target := range sortedNames(config.Fields) {
		texts := make([]string, 0)
		members := make([]int, 0)
		for at, document := range documents {
			if !live[at] || failed[at] != nil || resolvePath(document, target) != nil {
				continue
			}
			text, err := collectSourceText(document, config.Fields[target], target, at)
			if err != nil {
				if isSourceFailure(err) {
					failed[at] = err
					continue
				}
				return nil, err
			}
			texts = append(texts, text)
			members = append(members, at)
		}
		if len(texts) == 0 {
			continue
		}
		vectors, err := embedder.embedBatch(ctx, texts, model.EmbeddingForDocument)
		if err != nil {
			return nil, adapterFailure(err, target)
		}
		if len(vectors) != len(texts) {
			return nil, narsilerr.New(narsilerr.CodeEmbeddingFailed,
				fmt.Sprintf("Adapter returned %d vectors for %d inputs on field %q", len(vectors), len(texts), target),
				map[string]any{"field": target, "expected": len(texts), "actual": len(vectors)})
		}
		for at, member := range members {
			if err := validateEmbedded(vectors[at], target, dimensions); err != nil {
				return nil, err
			}
			setPathCopying(documents[member], target, append([]float32(nil), vectors[at]...))
		}
	}
	return failed, nil
}
