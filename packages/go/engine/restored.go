package engine

import (
	"sort"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/indexconfig"
	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type storedIndex struct {
	config      model.IndexConfig
	analysis    analysisSettings
	partitions  int
	createdAt   uint64
	sync        *syncState
	suggestions is.QuerySuggestionsState
}

func nestedSchema(flat map[string]string) model.Schema {
	root := model.Schema{}
	paths := make([]string, 0, len(flat))
	for path := range flat {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		segments := strings.Split(path, ".")
		holder := root
		for _, segment := range segments[:len(segments)-1] {
			next, isSchema := holder[segment].(model.Schema)
			if !isSchema {
				next = model.Schema{}
				holder[segment] = next
			}
			holder = next
		}
		holder[segments[len(segments)-1]] = model.FieldType(flat[path])
	}
	return root
}

func bm25FromSettings(stored *is.BM25) model.BM25Params {
	if stored == nil {
		return model.BM25Params{}
	}
	params := model.BM25Params{K1: stored.K1, B: stored.B}
	if stored.Fields != nil {
		params.Fields = make(map[string]model.BM25FieldParams, len(stored.Fields))
		for name, pair := range stored.Fields {
			params.Fields[name] = model.BM25FieldParams{K1: pair.K1, B: pair.B}
		}
	}
	return params
}

func partitionsFromSettings(stored *is.PartitionLimits) model.PartitionConfig {
	if stored == nil {
		return model.PartitionConfig{}
	}
	return model.PartitionConfig{MaxDocsPerPartition: fromUint32(stored.MaxDocsPerPartition),
		MaxPartitions: fromUint32(stored.MaxPartitions), Watermark: stored.Watermark}
}

func promotionFromSettings(stored *is.VectorPromotion) *model.VectorIndexConfig {
	if stored == nil {
		return nil
	}
	config := &model.VectorIndexConfig{Threshold: fromUint32(stored.Threshold), FilterThreshold: stored.FilterThreshold,
		Quantization: model.VectorQuantizationMode(stored.Quantization.Or("")),
		Storage:      model.VectorStorageMode(stored.Storage.Or(""))}
	if stored.HNSW != nil {
		config.HNSW = &model.HNSWConfig{M: fromUint32(stored.HNSW.M), EfConstruction: fromUint32(stored.HNSW.EfConstruction),
			Metric: model.VectorMetric(stored.HNSW.Metric.Or(""))}
	}
	return config
}

func embeddingFromSettings(stored *is.Embedding) *model.EmbeddingFieldConfig {
	if stored == nil {
		return nil
	}
	fields := make(map[string]model.EmbeddingSource, len(stored.Fields))
	for target, source := range stored.Fields {
		if source.List {
			fields[target] = model.EmbeddingSourceFields(source.Paths...)
			continue
		}
		path := ""
		if len(source.Paths) > 0 {
			path = source.Paths[0]
		}
		fields[target] = model.EmbeddingSourceField(path)
	}
	config := &model.EmbeddingFieldConfig{Fields: fields}
	if name, named := stored.Adapter.Get(); named {
		config.Adapter = model.RegisteredEmbeddingAdapter(name)
	}
	return config
}

func synonymsFromSettings(stored model.Optional[[]is.SynonymRule]) []model.SynonymRule {
	rules, set := stored.Get()
	if !set {
		return nil
	}
	converted := make([]model.SynonymRule, 0, len(rules))
	for _, rule := range rules {
		if rule.OneWay {
			converted = append(converted, model.OneWaySynonyms(rule.Word, rule.Synonyms...))
			continue
		}
		converted = append(converted, model.TwoWaySynonyms(rule.Words...))
	}
	return converted
}

func storedFromConfiguration(config indexconfig.Configuration) storedIndex {
	indexConfig := model.IndexConfig{
		Schema:            nestedSchema(config.Schema),
		Language:          config.Language,
		Partitions:        partitionsFromSettings(config.PartitionConfig),
		DefaultScoring:    model.ScoringMode(config.DefaultScoring.Or("")),
		BM25:              bm25FromSettings(config.BM25),
		TrackPositions:    config.TrackPositions,
		TextStorage:       model.TextStorage(config.TextStorage.Or("")),
		VectorPromotion:   promotionFromSettings(config.VectorPromotion),
		Strict:            config.Strict.Or(false),
		Embedding:         embeddingFromSettings(config.Embedding),
		SurfaceForms:      config.SurfaceForms,
		PatternValueLimit: fromUint32(config.PatternValueLimit),
		Synonyms:          synonymsFromSettings(config.Synonyms),
	}
	if required, set := config.Required.Get(); set {
		indexConfig.Required = required
	}
	if name, named := config.Tokenizer.Get(); named {
		indexConfig.Tokenizer = model.RegisteredTokenizer(name)
	}
	if name, named := config.StopWords.Get(); named {
		indexConfig.StopWords = model.RegisteredStopWords(name)
	} else if words, listed := config.StopWordList.Get(); listed {
		indexConfig.StopWords = model.StopWordList(words...)
	}
	return storedIndex{
		config: indexConfig,
		analysis: analysisSettings{language: config.Language, revision: config.AnalysisRevision.Or(""),
			tokenizer: config.Tokenizer, stopWords: config.StopWords, stopWordList: config.StopWordList,
			generation: config.AnalysisGeneration.Or(0)},
		suggestions: config.QuerySuggestions,
	}
}

func configurationOfMetadata(meta metadata.Metadata) indexconfig.Configuration {
	bm25 := meta.BM25
	return indexconfig.Configuration{
		Schema:             meta.Schema,
		Language:           meta.Language,
		AnalysisRevision:   meta.AnalysisRevision,
		ArrayPositionGap:   meta.ArrayPositionGap,
		Tokenizer:          meta.Tokenizer,
		StopWords:          meta.StopWords,
		StopWordList:       meta.StopWordList,
		AnalysisGeneration: meta.AnalysisGeneration,
		BM25:               &bm25,
		SurfaceForms:       meta.SurfaceFormsEnabled,
		PartitionConfig:    meta.PartitionLimits,
		DefaultScoring:     meta.DefaultScoring,
		TrackPositions:     meta.TrackPositions,
		TextStorage:        meta.TextStorage,
		Strict:             meta.Strict,
		Required:           meta.Required,
		VectorPromotion:    meta.VectorPromotion,
		PatternValueLimit:  meta.PatternValueLimit,
		Synonyms:           meta.Synonyms,
		Embedding:          meta.Embedding,
		SyncEpoch:          meta.SyncEpoch,
		QuerySuggestions:   meta.QuerySuggestions,
	}
}

func storedFromMetadata(meta metadata.Metadata) storedIndex {
	stored := storedFromConfiguration(configurationOfMetadata(meta))
	stored.partitions = int(meta.PartitionCount)
	stored.createdAt = meta.CreatedAt
	stored.sync = syncStateOfMetadata(meta)
	return stored
}
