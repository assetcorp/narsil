package engine

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/indexconfig"
	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func flatSchemaOf(parsed *schema.Parsed) map[string]string {
	flat := parsed.Flatten()
	out := make(map[string]string, len(flat))
	for path, fieldType := range flat {
		out[path] = string(fieldType)
	}
	return out
}

func pairOf(k1, b model.Optional[float64]) is.BM25Pair {
	return is.BM25Pair{K1: k1, B: b}
}

func bm25FieldsOf(params model.BM25Params) map[string]is.BM25Pair {
	if params.Fields == nil {
		return nil
	}
	fields := make(map[string]is.BM25Pair, len(params.Fields))
	for name, pair := range params.Fields {
		fields[name] = pairOf(pair.K1, pair.B)
	}
	return fields
}

func bm25IsSet(params model.BM25Params) bool {
	return params.K1.IsSet() || params.B.IsSet() || params.Fields != nil
}

func metadataBM25(params model.BM25Params) is.BM25 {
	return is.BM25{BM25Pair: pairOf(model.Some(params.K1.Or(defaultBM25K1)), model.Some(params.B.Or(defaultBM25B))),
		Fields: bm25FieldsOf(params)}
}

func configurationBM25(params model.BM25Params) *is.BM25 {
	if !bm25IsSet(params) {
		return nil
	}
	return &is.BM25{BM25Pair: pairOf(params.K1, params.B), Fields: bm25FieldsOf(params)}
}

func toUint32(value model.Optional[int]) model.Optional[uint32] {
	held, set := value.Get()
	if !set || held < 0 {
		return model.Optional[uint32]{}
	}
	return model.Some(uint32(held))
}

func fromUint32(value model.Optional[uint32]) model.Optional[int] {
	held, set := value.Get()
	if !set {
		return model.Optional[int]{}
	}
	return model.Some(int(held))
}

func partitionLimitsOf(config model.PartitionConfig) *is.PartitionLimits {
	if !config.MaxDocsPerPartition.IsSet() && !config.MaxPartitions.IsSet() && !config.Watermark.IsSet() {
		return nil
	}
	return &is.PartitionLimits{MaxDocsPerPartition: toUint32(config.MaxDocsPerPartition),
		MaxPartitions: toUint32(config.MaxPartitions), Watermark: config.Watermark}
}

func optionalText[T ~string](value T) model.Optional[string] {
	if value == "" {
		return model.Optional[string]{}
	}
	return model.Some(string(value))
}

func vectorPromotionOf(config *model.VectorIndexConfig) *is.VectorPromotion {
	if config == nil {
		return nil
	}
	promotion := &is.VectorPromotion{Threshold: toUint32(config.Threshold), FilterThreshold: config.FilterThreshold,
		Quantization: optionalText(config.Quantization), Storage: optionalText(config.Storage)}
	if config.HNSW != nil {
		promotion.HNSW = &is.HNSWConfig{M: toUint32(config.HNSW.M), EfConstruction: toUint32(config.HNSW.EfConstruction),
			Metric: optionalText(config.HNSW.Metric)}
	}
	return promotion
}

func embeddingOf(config *model.EmbeddingFieldConfig, adapterName string) *is.Embedding {
	if config == nil {
		return nil
	}
	fields := make(map[string]is.EmbeddingSource, len(config.Fields))
	for target, source := range config.Fields {
		fields[target] = is.EmbeddingSource{Paths: source.Fields(), List: source.IsList()}
	}
	embedding := &is.Embedding{Fields: fields}
	if adapterName != "" {
		embedding.Adapter = model.Some(adapterName)
	}
	return embedding
}

func synonymSettingsOf(rules []model.SynonymRule) model.Optional[[]is.SynonymRule] {
	if rules == nil {
		return model.Optional[[]is.SynonymRule]{}
	}
	stored := make([]is.SynonymRule, 0, len(rules))
	for _, rule := range rules {
		if words, twoWay := rule.TwoWay(); twoWay {
			stored = append(stored, is.SynonymRule{Words: words})
			continue
		}
		if word, synonyms, oneWay := rule.OneWay(); oneWay {
			stored = append(stored, is.SynonymRule{OneWay: true, Word: word, Synonyms: synonyms})
		}
	}
	return model.Some(stored)
}

func patternLimitOf(value model.Optional[int]) model.Optional[uint32] {
	return toUint32(value)
}

func optionalFlag(value bool, set bool) model.Optional[bool] {
	if !set {
		return model.Optional[bool]{}
	}
	return model.Some(value)
}

func requiredOf(required []string) model.Optional[[]string] {
	if required == nil {
		return model.Optional[[]string]{}
	}
	return model.Some(append([]string(nil), required...))
}

func (entry *indexEntry) refuseCode() error {
	if entry.currentAnalysis().customCode {
		if _, custom := entry.currentConfig().Tokenizer.Custom(); custom {
			return narsilerr.New(narsilerr.CodeConfigInvalid,
				"A snapshot persists no code, so the index tokenizer must be a name registered with RegisterTokenizer", nil)
		}
		return narsilerr.New(narsilerr.CodeConfigInvalid,
			"A snapshot persists no code, so the index stop words must be a name registered with RegisterStopWords", nil)
	}
	return nil
}

func (entry *indexEntry) generation() model.Optional[uint64] {
	generation := entry.currentAnalysis().generation
	if generation == 0 {
		return model.Optional[uint64]{}
	}
	return model.Some(generation)
}

func (entry *indexEntry) configuration() (indexconfig.Configuration, error) {
	if err := entry.refuseCode(); err != nil {
		return indexconfig.Configuration{}, err
	}
	return entry.configurationFields(), nil
}

func (entry *indexEntry) configurationFields() indexconfig.Configuration {
	config := entry.currentConfig()
	held := entry.currentAnalysis()
	return indexconfig.Configuration{
		Schema:             flatSchemaOf(entry.parsed),
		SchemaOrder:        entry.parsed.FieldOrder(),
		Language:           held.language,
		AnalysisRevision:   optionalText(held.revision),
		ArrayPositionGap:   entry.recordedGap(),
		Tokenizer:          held.tokenizer,
		StopWords:          held.stopWords,
		StopWordList:       held.stopWordList,
		AnalysisGeneration: entry.generation(),
		BM25:               configurationBM25(config.BM25),
		SurfaceForms:       model.Some(config.SurfaceForms.Or(true)),
		PartitionConfig:    partitionLimitsOf(config.Partitions),
		DefaultScoring:     optionalText(config.DefaultScoring),
		TrackPositions:     config.TrackPositions,
		TextStorage:        optionalText(config.TextStorage),
		Strict:             optionalFlag(config.Strict, config.Strict),
		Required:           requiredOf(config.Required),
		VectorPromotion:    vectorPromotionOf(config.VectorPromotion),
		PatternValueLimit:  patternLimitOf(config.PatternValueLimit),
		Synonyms:           synonymSettingsOf(config.Synonyms),
		Embedding:          embeddingOf(config.Embedding, entry.embeddingName),
		SyncEpoch:          entry.sync.archiveEpoch(),
		QuerySuggestions:   entry.suggestions.current(),
	}
}

func (entry *indexEntry) vectorFieldsMetadata() map[string]metadata.VectorField {
	if len(entry.vectorPaths) == 0 {
		return nil
	}
	fields := make(map[string]metadata.VectorField, len(entry.vectorPaths))
	for _, path := range entry.vectorPaths {
		field, found := entry.handle.Vectors[path]
		if !found {
			continue
		}
		fields[path] = metadata.VectorField{Dimension: uint16(field.Dimension()), Metric: string(field.Metric()),
			Quantization: string(field.Quantization())}
	}
	return fields
}

func (entry *indexEntry) metadataOf(documentCount uint64) (metadata.Metadata, error) {
	config := entry.currentConfig()
	held := entry.currentAnalysis()
	described := metadata.Metadata{
		IndexName:           entry.name,
		Schema:              flatSchemaOf(entry.parsed),
		SchemaOrder:         entry.parsed.FieldOrder(),
		Language:            held.language,
		PartitionCount:      uint32(entry.index().PartitionCount()),
		DocumentCount:       model.Some(documentCount),
		BM25:                metadataBM25(config.BM25),
		CreatedAt:           entry.createdAt,
		EngineVersion:       engineVersion,
		VectorFields:        entry.vectorFieldsMetadata(),
		Embedding:           embeddingOf(config.Embedding, entry.embeddingName),
		SurfaceFormsEnabled: model.Some(config.SurfaceForms.Or(true)),
		AnalysisRevision:    optionalText(held.revision),
		ArrayPositionGap:    entry.recordedGap(),
		Tokenizer:           held.tokenizer,
		StopWords:           held.stopWords,
		StopWordList:        held.stopWordList,
		AnalysisGeneration:  entry.generation(),
		PendingAnalysis:     entry.pendingAnalysisMetadata(),
		PartitionLimits:     partitionLimitsOf(config.Partitions),
		DefaultScoring:      optionalText(config.DefaultScoring),
		TrackPositions:      config.TrackPositions,
		TextStorage:         optionalText(config.TextStorage),
		Strict:              optionalFlag(config.Strict, config.Strict),
		Required:            requiredOf(config.Required),
		VectorPromotion:     vectorPromotionOf(config.VectorPromotion),
		PatternValueLimit:   patternLimitOf(config.PatternValueLimit),
		Synonyms:            synonymSettingsOf(config.Synonyms),
		QuerySuggestions:    entry.suggestions.current(),
	}
	entry.sync.describe(&described)
	return described, nil
}

func stopWordListOf(set model.StopWordSet) []string {
	words := make([]string, 0, len(set))
	for word := range set {
		words = append(words, word)
	}
	sort.Strings(words)
	return words
}
