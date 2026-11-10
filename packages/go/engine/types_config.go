package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

// Config carries the engine-wide settings of New: persistence and
// durability, worker copies, adapters, tokenisers and stop word sets bound by
// name, plugins, event handlers, and memory limits. The zero value gives an
// engine that keeps everything in memory.
type Config = model.Config

// WorkerConfig sets the query workers that serve an index once it grows past
// the promotion threshold.
type WorkerConfig = model.WorkerConfig

// MainCopyQueries picks whether the calling goroutine answers queries while
// the workers serve an index.
type MainCopyQueries = model.MainCopyQueries

const (
	// MainCopyQueriesLone lets the caller answer a query while no worker is free.
	MainCopyQueriesLone = model.MainCopyQueriesLone
	// MainCopyQueriesNone sends every query of a promoted index to a worker.
	MainCopyQueriesNone = model.MainCopyQueriesNone
)

// DurabilityConfig sets the write-ahead log or snapshot tier and how often
// the engine checkpoints.
type DurabilityConfig = model.DurabilityConfig

// DurabilityTier picks the write-ahead log tier or the snapshot tier.
type DurabilityTier = model.DurabilityTier

const (
	// DurabilityWAL logs every write in a directory before acknowledging it.
	DurabilityWAL = model.DurabilityWAL
	// DurabilitySnapshot saves checkpoints through a persistence adapter.
	DurabilitySnapshot = model.DurabilitySnapshot
)

// DurabilityMode picks whether a write waits for the disk.
type DurabilityMode = model.DurabilityMode

const (
	// DurabilitySync acknowledges a write once the disk confirms its log record.
	DurabilitySync = model.DurabilitySync
	// DurabilityAsync acknowledges a write at once and flushes the log on an interval.
	DurabilityAsync = model.DurabilityAsync
)

// AnalysisConfig sets what the engine does with an index whose saved terms an
// earlier analysis produced.
type AnalysisConfig = model.AnalysisConfig

// AnalysisRebuildMode picks an automatic or a manual rebuild of stale terms.
type AnalysisRebuildMode = model.AnalysisRebuildMode

const (
	// AnalysisRebuildAuto rebuilds stale terms as soon as recovery finds them.
	AnalysisRebuildAuto = model.AnalysisRebuildAuto
	// AnalysisRebuildManual leaves stale terms until RebuildAnalysis runs.
	AnalysisRebuildManual = model.AnalysisRebuildManual
)

// StaleAnalysis describes an index whose saved terms an earlier analysis produced.
type StaleAnalysis = model.StaleAnalysis

// IndexLifecycleConfig sets when the engine closes idle indexes.
type IndexLifecycleConfig = model.IndexLifecycleConfig

// MemoryConfig sets the heap fractions at which the engine blocks and
// resumes writes.
type MemoryConfig = model.MemoryConfig

// QuerySuggestionsConfig carries the key that scrambles the people behind
// recorded queries.
type QuerySuggestionsConfig = model.QuerySuggestionsConfig

// InsertContext is what a plugin's insert hooks receive.
type InsertContext = model.InsertContext

// RemoveContext is what a plugin's remove hooks receive.
type RemoveContext = model.RemoveContext

// UpdateContext is what a plugin's update hooks receive.
type UpdateContext = model.UpdateContext

// SearchContext is what a plugin's search hooks receive.
type SearchContext = model.SearchContext

// IndexContext is what a plugin's index hooks receive.
type IndexContext = model.IndexContext

// PartitionContext is what a plugin's partition hook receives.
type PartitionContext = model.PartitionContext

// WorkerContext is what a plugin's worker hook receives.
type WorkerContext = model.WorkerContext

// Plugin is a named set of hooks that the engine calls around writes,
// searches, and index changes. An error from a before hook refuses the write
// with CodeDocValidationFailed unless it already carries an engine code; the
// engine recovers a panic in any hook and reports it the same way.
type Plugin = model.Plugin
