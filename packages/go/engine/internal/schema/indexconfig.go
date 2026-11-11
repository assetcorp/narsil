package schema

import (
	"fmt"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func configInvalid(message string, details map[string]any) *narsilerr.Error {
	return narsilerr.New(narsilerr.CodeConfigInvalid, message, details)
}

func embeddingInvalid(message string, details map[string]any) *narsilerr.Error {
	return narsilerr.New(narsilerr.CodeEmbeddingConfigInvalid, message, details)
}

func ValidatePartitionConfig(partitions model.PartitionConfig) error {
	if maxDocs, set := partitions.MaxDocsPerPartition.Get(); set && maxDocs < 1 {
		return configInvalid("partitions.maxDocsPerPartition must be a positive integer", map[string]any{"maxDocsPerPartition": maxDocs})
	}
	if maxPartitions, set := partitions.MaxPartitions.Get(); set && maxPartitions < 1 {
		return configInvalid("partitions.maxPartitions must be a positive integer", map[string]any{"maxPartitions": maxPartitions})
	}
	if maxPartitions, set := partitions.MaxPartitions.Get(); set && maxPartitions > MaxPartitions {
		return configInvalid(fmt.Sprintf("partitions.maxPartitions must be at most %d", MaxPartitions),
			map[string]any{"maxPartitions": maxPartitions})
	}
	if watermark, set := partitions.Watermark.Get(); set && (!(watermark > 0) || watermark > 1) {
		return configInvalid("partitions.watermark must be above 0 and at most 1", map[string]any{"watermark": watermark})
	}
	return nil
}

func ValidatePatternValueLimit(limit model.Optional[int]) error {
	value, set := limit.Get()
	if !set || (value >= MinPatternValueLimit && value <= MaxPatternValueLimit) {
		return nil
	}
	return configInvalid(
		fmt.Sprintf("patternValueLimit must be a whole number of code points from %d to %d", MinPatternValueLimit, MaxPatternValueLimit),
		map[string]any{"patternValueLimit": value},
	)
}

func RequireSurfaceFormsForPartialFields(parsed *Parsed, surfaceForms model.Optional[bool]) error {
	enabled, set := surfaceForms.Get()
	if !set || enabled || parsed == nil || len(parsed.partial) == 0 {
		return nil
	}
	return configInvalid(
		fmt.Sprintf("Field %q declares \"partial\", which compares words as the documents wrote them, so its index needs surfaceForms left on", parsed.partial[0]),
		map[string]any{"fields": parsed.PartialFields(), "surfaceForms": false},
	)
}

func isQuantizationMode(mode model.VectorQuantizationMode) bool {
	switch mode {
	case model.QuantizationOSQ8, model.QuantizationOSQ4, model.QuantizationOSQ2, model.QuantizationOSQ1, model.QuantizationNone:
		return true
	default:
		return false
	}
}

func isVectorMetric(metric model.VectorMetric) bool {
	return metric == model.MetricCosine || metric == model.MetricDotProduct || metric == model.MetricEuclidean
}

func ValidateVectorPromotion(config *model.VectorIndexConfig) error {
	if config == nil {
		return nil
	}
	if threshold, set := config.Threshold.Get(); set && threshold < 1 {
		return configInvalid("vectorPromotion.threshold must be a positive integer", map[string]any{"threshold": threshold})
	}
	if config.Quantization != "" && !isQuantizationMode(config.Quantization) {
		return configInvalid("vectorPromotion.quantization must be 'osq8', 'osq4', 'osq2', 'osq1', or 'none'", map[string]any{"quantization": string(config.Quantization)})
	}
	if config.Storage != "" && config.Storage != model.VectorStorageMemory && config.Storage != model.VectorStorageDisk {
		return configInvalid("vectorPromotion.storage must be 'memory' or 'disk'", map[string]any{"storage": string(config.Storage)})
	}
	if config.HNSW == nil {
		return nil
	}
	if neighbours, set := config.HNSW.M.Get(); set && (neighbours < MinHNSWNeighbours || neighbours > MaxHNSWNeighbours) {
		return configInvalid(fmt.Sprintf("vectorPromotion.hnswConfig.m must be a whole number from %d to %d", MinHNSWNeighbours, MaxHNSWNeighbours), map[string]any{"m": neighbours})
	}
	if efConstruction, set := config.HNSW.EfConstruction.Get(); set && efConstruction < 1 {
		return configInvalid("vectorPromotion.hnswConfig.efConstruction must be a positive integer", map[string]any{"efConstruction": efConstruction})
	}
	if config.HNSW.Metric != "" && !isVectorMetric(config.HNSW.Metric) {
		return configInvalid("vectorPromotion.hnswConfig.metric must be 'cosine', 'dotProduct', or 'euclidean'", map[string]any{"metric": string(config.HNSW.Metric)})
	}
	return nil
}

func ValidateVectorStorage(config *model.VectorIndexConfig, filesystemDurability bool) error {
	if config == nil || config.Storage != model.VectorStorageDisk || filesystemDurability {
		return nil
	}
	return configInvalid("vectorPromotion.storage 'disk' needs filesystem durability, because a checkpoint file holds the vectors", map[string]any{"storage": string(config.Storage)})
}

func ValidateTextStorage(storage model.TextStorage, filesystemDurability bool) error {
	if storage == "" || storage == model.TextStorageMemory || (storage == model.TextStorageDisk && filesystemDurability) {
		return nil
	}
	return configInvalid("textStorage must be 'memory', or 'disk' with filesystem durability", map[string]any{"textStorage": string(storage)})
}

func ValidateEmbeddingConfig(fields map[string]model.EmbeddingSource, adapter model.EmbeddingAdapter, fallback model.EmbeddingAdapter, parsed *Parsed) (model.EmbeddingAdapter, error) {
	if len(fields) == 0 {
		return nil, embeddingInvalid("Embedding config must define at least one field mapping", nil)
	}
	resolved := adapter
	if resolved == nil {
		resolved = fallback
	}
	if resolved == nil {
		return nil, embeddingInvalid("Embedding config requires an adapter (set on the index or the instance)", nil)
	}
	dimensions := resolved.Dimensions()
	if dimensions <= 0 {
		return nil, embeddingInvalid(fmt.Sprintf("Adapter dimensions must be a positive integer, got %d", dimensions), nil)
	}
	for _, target := range sortedKeys(fields) {
		if err := validateEmbeddingTarget(target, fields[target], dimensions, parsed); err != nil {
			return nil, err
		}
	}
	return resolved, nil
}

func (p *Parsed) declared(path string) (Field, bool) {
	if p == nil {
		return Field{}, false
	}
	field, found := p.byPath[path]
	return field, found
}

func validateEmbeddingTarget(target string, source model.EmbeddingSource, dimensions int, parsed *Parsed) error {
	field, declared := parsed.declared(target)
	if !declared {
		return embeddingInvalid(fmt.Sprintf("Embedding target field %q does not exist in the schema", target), map[string]any{"field": target})
	}
	if field.Base != BaseVector {
		return embeddingInvalid(fmt.Sprintf("Embedding target field %q must be a vector type, got %q", target, field.Type), map[string]any{"field": target, "type": string(field.Type)})
	}
	if field.Dimension != dimensions {
		return narsilerr.New(
			narsilerr.CodeEmbeddingDimensionMismatch,
			fmt.Sprintf("Embedding target field %q has dimension %d but the adapter produces %d-dimensional vectors", target, field.Dimension, dimensions),
			map[string]any{"field": target, "expected": field.Dimension, "actual": dimensions},
		)
	}
	sources := source.Fields()
	if len(sources) == 0 {
		return embeddingInvalid(fmt.Sprintf("Embedding target field %q must have at least one source field", target), map[string]any{"field": target})
	}
	for _, name := range sources {
		sourceField, exists := parsed.declared(name)
		if !exists {
			return embeddingInvalid(fmt.Sprintf("Embedding source field %q does not exist in the schema", name), map[string]any{"field": name, "targetField": target})
		}
		if sourceField.Base != BaseString {
			return embeddingInvalid(
				fmt.Sprintf("Embedding source field %q must be a string type, got %q", name, sourceField.Type),
				map[string]any{"field": name, "type": string(sourceField.Type), "targetField": target},
			)
		}
	}
	return nil
}

func ValidateRegisteredEmbeddingAdapter(name string, adapter model.EmbeddingAdapter) error {
	if strings.TrimSpace(name) == "" {
		return embeddingInvalid("Embedding adapter names must be non-empty strings", nil)
	}
	if adapter == nil {
		return embeddingInvalid(fmt.Sprintf("Embedding adapter %q must provide an embed function", name), map[string]any{"adapter": name})
	}
	if dimensions := adapter.Dimensions(); dimensions <= 0 {
		return embeddingInvalid(
			fmt.Sprintf("Embedding adapter %q dimensions must be a positive integer, got %d", name, dimensions),
			map[string]any{"adapter": name, "dimensions": dimensions},
		)
	}
	return nil
}

func ValidateRequiredFieldsInSchema(required []string, parsed *Parsed) error {
	for _, field := range required {
		if _, declared := parsed.declared(field); !declared {
			return embeddingInvalid(fmt.Sprintf("Required field %q does not exist in the schema", field), map[string]any{"field": field})
		}
	}
	return nil
}
