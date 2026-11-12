package engine

import (
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/synonyms"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
)

type buildRequest struct {
	name          string
	config        model.IndexConfig
	parsed        *schema.Parsed
	partitions    int
	createdAt     uint64
	stored        *analysisSettings
	strictWords   bool
	embedder      model.EmbeddingAdapter
	embeddingName string
	sync          *feedState
}

func (n *Narsil) resolveAnalysis(config model.IndexConfig) (analysis.Settings, analysisSettings, error) {
	language := config.Language
	if language == "" {
		language = defaultLanguage
	}
	settings := analysis.Settings{Language: language, StopWords: config.StopWords}
	described := analysisSettings{language: language}
	if tokenizer, custom := config.Tokenizer.Custom(); custom {
		settings.Tokenizer = tokenizer
		described.customCode = true
	} else if name, named := config.Tokenizer.RegisteredName(); named {
		tokenizer, err := n.adapters.analysis.Tokenizer(name)
		if err != nil {
			return analysis.Settings{}, analysisSettings{}, err
		}
		settings.Tokenizer = tokenizer
		described.tokenizer = model.Some(name)
	}
	if set, listed := config.StopWords.Set(); listed {
		described.stopWordList = model.Some(stopWordListOf(set))
	} else if _, function := config.StopWords.Function(); function {
		described.customCode = true
	} else if name, named := config.StopWords.RegisteredName(); named {
		stopWords, err := n.adapters.analysis.StopWords(name)
		if err != nil {
			return analysis.Settings{}, analysisSettings{}, err
		}
		settings.StopWords = stopWords
		described.stopWords = model.Some(name)
	}
	return settings, described, nil
}

func (n *Narsil) buildEntry(request buildRequest) (*indexEntry, error) {
	config := request.config
	settings, described, err := n.resolveAnalysis(config)
	if err != nil {
		return nil, err
	}
	analyzer, err := analysis.New(settings)
	if err != nil {
		return nil, err
	}
	described.revision = core.LanguageRevision(analyzer.Language())
	described.language = analyzer.LanguageName()
	if request.stored != nil {
		described.generation = request.stored.generation
		if request.stored.revision != "" {
			described.revision = request.stored.revision
		}
	}
	lookup, rules, err := prepareSynonyms(analyzer, config.Synonyms, request.strictWords)
	if err != nil {
		return nil, err
	}
	config.Synonyms = rules
	createdAt := request.createdAt
	if createdAt == 0 {
		createdAt = uint64(time.Now().UnixMilli())
	}
	entry := &indexEntry{
		name:           request.name,
		config:         config,
		parsed:         request.parsed,
		analyzer:       analyzer,
		analysis:       described,
		vectorPaths:    sortedVectorPaths(request.parsed),
		createdAt:      createdAt,
		partitionCount: request.partitions,
		patternLimit:   config.PatternValueLimit.Or(schema.DefaultPatternValueLimit),
		embeddingName:  request.embeddingName,
		embedder:       request.embedder,
	}
	entry.phraseReady = func() error { return n.requirePhraseReady(entry) }
	entry.retireIndexes = n.retireIndexes
	entry.sync.adopt(request.sync)
	slots, err := vector.NewSlots()
	if err != nil {
		return nil, err
	}
	defer slots.Close()
	vectors, err := buildVectorFields(request.name, request.parsed, config.VectorPromotion, n.defaultVectorStorage(), slots)
	if err != nil {
		return nil, err
	}
	source := &vectorSource{fields: vectors, names: entry.vectorPaths}
	indexSettings := index.Settings{
		Name:            request.name,
		Schema:          request.parsed,
		PartitionCount:  request.partitions,
		Analyzer:        analyzer,
		Synonyms:        lookup,
		DefaultScoring:  config.DefaultScoring,
		TrackPositions:  config.TrackPositions.Or(true),
		CollectSurfaces: config.SurfaceForms.Or(true),
		Strict:          config.Strict,
		SearchWorkCap:   n.config.PatternWorkCap.Or(0),
		Vectors:         source,
		Slots:           slots,
		PatternLimit:    uint32(entry.patternLimit),
		TextOnDisk:      config.TextStorage == model.TextStorageDisk,
	}
	if bm25IsSet(config.BM25) {
		params := config.BM25
		indexSettings.BM25 = &params
	}
	built, err := index.New(indexSettings)
	if err != nil {
		disposeFields(vectors)
		return nil, err
	}
	entry.handle = &persist.Handle{
		Name:    request.name,
		Index:   built,
		Schema:  request.parsed,
		Vectors: vectors,
		Metadata: func(documentCount uint64) (metadata.Metadata, error) {
			return entry.metadataOf(documentCount)
		},
		NewDetachedIndex: detachedBuilder(indexSettings, built),
		SyncHistoryMoved: func() { n.syncRetention.schedule(n, request.name) },
		RecordsPrevious:  entry.sync.recordsPreviousDocuments,
	}
	entry.swap.adopt(built, indexSettings)
	return entry, nil
}

func prepareSynonyms(analyzer *analysis.Analyzer, rules []model.SynonymRule, strictWords bool) (*synonyms.Lookup, []model.SynonymRule, error) {
	if len(rules) == 0 {
		return nil, nil, nil
	}
	pass, err := analyzer.Prepare()
	if err != nil {
		return nil, nil, err
	}
	prepared, err := synonyms.Prepare(rules, pass, strictWords, "")
	if err != nil || prepared == nil {
		return nil, nil, err
	}
	decoded, err := synonyms.DecodeRules(prepared.Encoded)
	if err != nil {
		return nil, nil, err
	}
	return prepared.Lookup, decoded, nil
}

func (n *Narsil) defaultVectorStorage() model.VectorStorageMode {
	if n.filesystemDurability() {
		return model.VectorStorageDisk
	}
	return model.VectorStorageMemory
}

func buildVectorFields(indexName string, parsed *schema.Parsed, promotion *model.VectorIndexConfig,
	defaultStorage model.VectorStorageMode, slots *vector.Slots) (map[string]*vector.Field, error) {
	fields := map[string]*vector.Field{}
	storage := defaultStorage
	if promotion != nil && promotion.Storage != "" {
		storage = promotion.Storage
	}
	for _, path := range sortedVectorPaths(parsed) {
		field, err := vector.New(vector.Config{FieldName: path, IndexName: indexName,
			Dimension: parsed.VectorFields()[path], Index: promotion, Storage: storage, Slots: slots})
		if err != nil {
			disposeFields(fields)
			return nil, err
		}
		fields[path] = field
	}
	return fields, nil
}

func disposeFields(fields map[string]*vector.Field) {
	for _, field := range fields {
		field.Dispose()
	}
}
