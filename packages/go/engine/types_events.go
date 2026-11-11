package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

// EventName is the name of one kind of engine event.
type EventName = model.EventName

const (
	// EventWrite fires after a call changes the documents or settings of an index.
	EventWrite = model.EventWrite
	// EventWorkerCrash fires when a query worker stops while it holds work.
	EventWorkerCrash = model.EventWorkerCrash
	// EventWorkerPromote fires when an index starts serving queries from the workers.
	EventWorkerPromote = model.EventWorkerPromote
	// EventWorkerPromoteFailure fires when an index cannot start serving from the workers.
	EventWorkerPromoteFailure = model.EventWorkerPromoteFailure
	// EventPartitionRebalance fires after an index changes its partition count.
	EventPartitionRebalance = model.EventPartitionRebalance
	// EventPartitionWatermark fires when an index fills past its partition watermark.
	EventPartitionWatermark = model.EventPartitionWatermark
	// EventHeapPressure fires when the heap passes the warning fraction of its limit.
	EventHeapPressure = model.EventHeapPressure
	// EventAnalysisRebuild fires as an analysis rebuild starts, completes, or fails.
	EventAnalysisRebuild = model.EventAnalysisRebuild
	// EventLayoutUpgrade fires as recovery upgrades the files of an earlier release.
	EventLayoutUpgrade = model.EventLayoutUpgrade
	// EventCheckpointHeld fires when the engine holds a checkpoint back.
	EventCheckpointHeld = model.EventCheckpointHeld
	// EventDurabilityError fires when a background save fails, after which writes stop.
	EventDurabilityError = model.EventDurabilityError
	// EventInvalidationError fires when a cache invalidation fails.
	EventInvalidationError = model.EventInvalidationError
	// EventQuerySuggestionsBuild fires as a popular query build moves between phases.
	EventQuerySuggestionsBuild = model.EventQuerySuggestionsBuild
	// EventQuerySuggestionsWarning fires when popular query suggestions meet a problem they recover from.
	EventQuerySuggestionsWarning = model.EventQuerySuggestionsWarning
)

// Event is one engine event; switch on its concrete type to read the payload.
type Event = model.Event

// WriteEvent reports a write to one index.
type WriteEvent = model.WriteEvent

// WorkerCrashEvent reports a query worker that stopped.
type WorkerCrashEvent = model.WorkerCrashEvent

// WorkerPromoteEvent reports the engine starting its query workers.
type WorkerPromoteEvent = model.WorkerPromoteEvent

// WorkerPromoteFailureEvent reports a promotion that failed.
type WorkerPromoteFailureEvent = model.WorkerPromoteFailureEvent

// PartitionRebalanceEvent reports a change of partition count.
type PartitionRebalanceEvent = model.PartitionRebalanceEvent

// PartitionWatermarkEvent reports an index that filled past its watermark.
type PartitionWatermarkEvent = model.PartitionWatermarkEvent

// HeapPressureEvent reports heap use near its limit.
type HeapPressureEvent = model.HeapPressureEvent

// ProgressStatus is the phase that a progress event reports.
type ProgressStatus = model.ProgressStatus

const (
	// ProgressStarted marks work that has begun.
	ProgressStarted = model.ProgressStarted
	// ProgressCompleted marks work that has finished.
	ProgressCompleted = model.ProgressCompleted
	// ProgressFailed marks work that has stopped with an error.
	ProgressFailed = model.ProgressFailed
)

// AnalysisRebuildEvent reports the progress of an analysis rebuild.
type AnalysisRebuildEvent = model.AnalysisRebuildEvent

// EarlierLayout names the layout of an earlier release that recovery upgrades.
type EarlierLayout = model.EarlierLayout

const (
	// EarlierLayoutManifest marks a segment manifest of an earlier release.
	EarlierLayoutManifest = model.EarlierLayoutManifest
	// EarlierLayoutBundle marks a snapshot bundle of an earlier release.
	EarlierLayoutBundle = model.EarlierLayoutBundle
)

// LayoutUpgradeEvent reports the progress of a layout upgrade.
type LayoutUpgradeEvent = model.LayoutUpgradeEvent

// CheckpointHeldEvent reports a checkpoint that the engine is holding back.
type CheckpointHeldEvent = model.CheckpointHeldEvent

// DurabilityErrorEvent reports a background save that failed.
type DurabilityErrorEvent = model.DurabilityErrorEvent

// InvalidationErrorEvent reports a cache invalidation that failed.
type InvalidationErrorEvent = model.InvalidationErrorEvent

// QuerySuggestionsBuildEvent reports the phase of a popular query build.
type QuerySuggestionsBuildEvent = model.QuerySuggestionsBuildEvent

// QuerySuggestionsWarningEvent reports a popular query problem that the engine recovered from.
type QuerySuggestionsWarningEvent = model.QuerySuggestionsWarningEvent

// EventHandlers holds one optional listener per kind of event. Pass it in
// Config.Events, or to On to add listeners later.
type EventHandlers = model.EventHandlers
