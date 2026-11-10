package model

type EventName string

const (
	EventWrite                   EventName = "write"
	EventWorkerCrash             EventName = "workerCrash"
	EventWorkerPromote           EventName = "workerPromote"
	EventWorkerPromoteFailure    EventName = "workerPromoteFailure"
	EventPartitionRebalance      EventName = "partitionRebalance"
	EventPartitionWatermark      EventName = "partitionWatermark"
	EventHeapPressure            EventName = "heapPressure"
	EventAnalysisRebuild         EventName = "analysisRebuild"
	EventLayoutUpgrade           EventName = "layoutUpgrade"
	EventCheckpointHeld          EventName = "checkpointHeld"
	EventDurabilityError         EventName = "durabilityError"
	EventInvalidationError       EventName = "invalidationError"
	EventQuerySuggestionsBuild   EventName = "querySuggestionsBuild"
	EventQuerySuggestionsWarning EventName = "querySuggestionsWarning"
)

type Event interface {
	EventName() EventName
}

type WriteEvent struct {
	IndexName string
}

type WorkerCrashEvent struct {
	WorkerID   int
	IndexNames []string
	Err        error
}

type WorkerPromoteEvent struct {
	WorkerCount int
	Reason      string
}

type WorkerPromoteFailureEvent struct {
	Reason    string
	Err       error
	Retryable bool
}

type PartitionRebalanceEvent struct {
	IndexName string
	OldCount  int
	NewCount  int
}

type PartitionWatermarkEvent struct {
	IndexName      string
	DocumentCount  int
	Capacity       int
	PartitionCount int
}

type HeapPressureEvent struct {
	IndexName            string
	HeapUsed             int64
	HeapLimit            int64
	EstimatedMemoryBytes int64
}

type ProgressStatus string

const (
	ProgressStarted   ProgressStatus = "started"
	ProgressCompleted ProgressStatus = "completed"
	ProgressFailed    ProgressStatus = "failed"
)

type AnalysisRebuildEvent struct {
	IndexName         string
	Status            ProgressStatus
	PartitionsRebuilt int
	PartitionCount    int
	Err               error
}

type EarlierLayout string

const (
	EarlierLayoutManifest EarlierLayout = "manifest"
	EarlierLayoutBundle   EarlierLayout = "bundle"
)

type LayoutUpgradeEvent struct {
	IndexName string
	Status    ProgressStatus
	Layout    EarlierLayout
	Err       error
}

type CheckpointHeldEvent struct {
	HeldCheckpointReport
}

type DurabilityErrorEvent struct {
	Err error
}

type InvalidationErrorEvent struct {
	Err error
}

func (WriteEvent) EventName() EventName                { return EventWrite }
func (WorkerCrashEvent) EventName() EventName          { return EventWorkerCrash }
func (WorkerPromoteEvent) EventName() EventName        { return EventWorkerPromote }
func (WorkerPromoteFailureEvent) EventName() EventName { return EventWorkerPromoteFailure }
func (PartitionRebalanceEvent) EventName() EventName   { return EventPartitionRebalance }
func (PartitionWatermarkEvent) EventName() EventName   { return EventPartitionWatermark }
func (HeapPressureEvent) EventName() EventName         { return EventHeapPressure }
func (AnalysisRebuildEvent) EventName() EventName      { return EventAnalysisRebuild }
func (LayoutUpgradeEvent) EventName() EventName        { return EventLayoutUpgrade }
func (CheckpointHeldEvent) EventName() EventName       { return EventCheckpointHeld }
func (DurabilityErrorEvent) EventName() EventName      { return EventDurabilityError }
func (InvalidationErrorEvent) EventName() EventName    { return EventInvalidationError }
func (QuerySuggestionsBuildEvent) EventName() EventName {
	return EventQuerySuggestionsBuild
}
func (QuerySuggestionsWarningEvent) EventName() EventName {
	return EventQuerySuggestionsWarning
}

type EventHandlers struct {
	Write                   func(WriteEvent)
	WorkerCrash             func(WorkerCrashEvent)
	WorkerPromote           func(WorkerPromoteEvent)
	WorkerPromoteFailure    func(WorkerPromoteFailureEvent)
	PartitionRebalance      func(PartitionRebalanceEvent)
	PartitionWatermark      func(PartitionWatermarkEvent)
	HeapPressure            func(HeapPressureEvent)
	AnalysisRebuild         func(AnalysisRebuildEvent)
	LayoutUpgrade           func(LayoutUpgradeEvent)
	CheckpointHeld          func(CheckpointHeldEvent)
	DurabilityError         func(DurabilityErrorEvent)
	InvalidationError       func(InvalidationErrorEvent)
	QuerySuggestionsBuild   func(QuerySuggestionsBuildEvent)
	QuerySuggestionsWarning func(QuerySuggestionsWarningEvent)
}

func (h EventHandlers) Dispatch(event Event) bool {
	switch payload := event.(type) {
	case WriteEvent:
		return call(h.Write, payload)
	case WorkerCrashEvent:
		return call(h.WorkerCrash, payload)
	case WorkerPromoteEvent:
		return call(h.WorkerPromote, payload)
	case WorkerPromoteFailureEvent:
		return call(h.WorkerPromoteFailure, payload)
	case PartitionRebalanceEvent:
		return call(h.PartitionRebalance, payload)
	case PartitionWatermarkEvent:
		return call(h.PartitionWatermark, payload)
	case HeapPressureEvent:
		return call(h.HeapPressure, payload)
	case AnalysisRebuildEvent:
		return call(h.AnalysisRebuild, payload)
	case LayoutUpgradeEvent:
		return call(h.LayoutUpgrade, payload)
	case CheckpointHeldEvent:
		return call(h.CheckpointHeld, payload)
	case DurabilityErrorEvent:
		return call(h.DurabilityError, payload)
	case InvalidationErrorEvent:
		return call(h.InvalidationError, payload)
	case QuerySuggestionsBuildEvent:
		return call(h.QuerySuggestionsBuild, payload)
	case QuerySuggestionsWarningEvent:
		return call(h.QuerySuggestionsWarning, payload)
	}
	return false
}

func call[T Event](listener func(T), payload T) bool {
	if listener == nil {
		return false
	}
	listener(payload)
	return true
}
