package model

import (
	"context"
	"time"
)

type Config struct {
	Persistence       PersistenceAdapter
	Plugins           []Plugin
	IDGenerator       func() string
	Workers           WorkerConfig
	Embedding         EmbeddingAdapter
	EmbeddingAdapters map[string]EmbeddingAdapter
	RerankAdapters    map[string]RerankAdapter
	Tokenizers        map[string]Tokenizer
	StopWordSets      map[string]StopWords
	RerankTimeout     Optional[time.Duration]
	MaxRerankWindow   Optional[int]
	Durability        *DurabilityConfig
	Analysis          AnalysisConfig
	Lifecycle         *IndexLifecycleConfig
	Events            EventHandlers
	PatternWorkCap    Optional[int64]
	Memory            MemoryConfig
	QuerySuggestions  *QuerySuggestionsConfig
}

type QuerySuggestionsConfig struct {
	Key []byte
}

type MemoryConfig struct {
	BlockWritesAbove  Optional[float64]
	ResumeWritesBelow Optional[float64]
}

type IndexLifecycleConfig struct {
	IdleTimeout      Optional[time.Duration]
	MaxOpenIndexes   Optional[int]
	MaxOpenBytes     Optional[int64]
	MaxReopenWaiters Optional[int]
}

type StaleAnalysis struct {
	IndexName       string
	Language        string
	StoredRevision  Optional[string]
	CurrentRevision string
	DocumentCount   int
}

type AnalysisRebuildMode string

const (
	AnalysisRebuildAuto   AnalysisRebuildMode = "auto"
	AnalysisRebuildManual AnalysisRebuildMode = "manual"
)

type AnalysisConfig struct {
	Rebuild         AnalysisRebuildMode
	OnStaleAnalysis func(ctx context.Context, index StaleAnalysis, rebuild func(ctx context.Context) error) error
}

type DurabilityTier string

const (
	DurabilityWAL      DurabilityTier = "wal"
	DurabilitySnapshot DurabilityTier = "snapshot"
)

type DurabilityMode string

const (
	DurabilitySync  DurabilityMode = "sync"
	DurabilityAsync DurabilityMode = "async"
)

type DurabilityConfig struct {
	Tier                        DurabilityTier
	Directory                   string
	Mode                        DurabilityMode
	FlushInterval               Optional[time.Duration]
	SegmentMaxBytes             Optional[int64]
	CheckpointInterval          Optional[time.Duration]
	CheckpointMutationThreshold Optional[int]
	CompactionThreshold         Optional[int]
	RewriteBytesPerCheckpoint   Optional[int64]
}

type MainCopyQueries string

const (
	MainCopyQueriesLone MainCopyQueries = "lone"
	MainCopyQueriesNone MainCopyQueries = "none"
)

type WorkerConfig struct {
	Enabled            Optional[bool]
	Count              Optional[int]
	PromotionThreshold Optional[int]
	IdleTimeout        Optional[time.Duration]
	MainCopyQueries    MainCopyQueries
}
