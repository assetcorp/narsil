package core

/*
#cgo CFLAGS: -std=c11 -D_POSIX_C_SOURCE=200809L -O2 -fvisibility=hidden
#cgo linux LDFLAGS: -lm
#include "native/include/narsil_core.h"
*/
import "C"

import "fmt"

const ExpectedABIVersion = C.NARSIL_CORE_ABI_VERSION

type Status int

const (
	StatusOK                Status = C.NARSIL_OK
	StatusInvalidArgument   Status = C.NARSIL_INVALID_ARGUMENT
	StatusOutOfMemory       Status = C.NARSIL_OUT_OF_MEMORY
	StatusNeedsRoom         Status = C.NARSIL_NEEDS_ROOM
	StatusGraphNotHeldAlone Status = C.NARSIL_GRAPH_NOT_HELD_ALONE
	StatusFileUnreadable    Status = C.NARSIL_FILE_UNREADABLE
	StatusWorkCapExceeded   Status = C.NARSIL_WORK_CAP_EXCEEDED
	StatusStopped           Status = C.NARSIL_STOPPED
	StatusSegmentFull       Status = C.NARSIL_SEGMENT_FULL
	StatusPageCorrupt       Status = C.NARSIL_PAGE_CORRUPT
	StatusPageUnreadable    Status = C.NARSIL_PAGE_UNREADABLE
	StatusPageInvalid       Status = C.NARSIL_PAGE_INVALID
)

type StatusError struct {
	Operation string
	Status    Status
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("the native search core refused %s with status %s", e.Operation, e.Status)
}

func (s Status) String() string {
	switch s {
	case StatusOK:
		return "ok"
	case StatusInvalidArgument:
		return "invalidArgument"
	case StatusOutOfMemory:
		return "outOfMemory"
	case StatusNeedsRoom:
		return "needsRoom"
	case StatusGraphNotHeldAlone:
		return "graphNotHeldAlone"
	case StatusFileUnreadable:
		return "fileUnreadable"
	case StatusWorkCapExceeded:
		return "workCapExceeded"
	case StatusStopped:
		return "stopped"
	case StatusSegmentFull:
		return "segmentFull"
	case StatusPageCorrupt:
		return "pageCorrupt"
	case StatusPageUnreadable:
		return "pageUnreadable"
	case StatusPageInvalid:
		return "pageInvalid"
	}
	return fmt.Sprintf("status(%d)", int(s))
}

func statusError(operation string, status C.narsil_status) error {
	if status == C.NARSIL_OK {
		return nil
	}
	return &StatusError{Operation: operation, Status: Status(status)}
}

func ABIVersion() int {
	return int(C.narsil_core_abi_version())
}

func RecordBytes(dimension, bits uint32) uint32 {
	return uint32(C.narsil_record_bytes(C.uint32_t(dimension), C.uint32_t(bits)))
}

const (
	GraphHeaderWords               = C.NARSIL_GRAPH_HEADER_WORDS
	StoreHeaderWords               = C.NARSIL_STORE_HEADER_WORDS
	HeldWordsPerThread             = C.NARSIL_HELD_WORDS_PER_THREAD
	OSQTrailerBytes                = C.NARSIL_OSQ_TRAILER_BYTES
	MaxPlacementLayers             = C.NARSIL_MAX_PLACEMENT_LAYERS
	ListWordsOverNeighbours        = C.NARSIL_LIST_WORDS_OVER_NEIGHBOURS
	GraphWordEntryPoint            = C.NARSIL_GRAPH_WORD_ENTRY_POINT
	GraphWordTopLayer              = C.NARSIL_GRAPH_WORD_TOP_LAYER
	GraphWordM                     = C.NARSIL_GRAPH_WORD_M
	GraphWordMMax0                 = C.NARSIL_GRAPH_WORD_MMAX0
	GraphWordEfConstruction        = C.NARSIL_GRAPH_WORD_EF_CONSTRUCTION
	GraphWordNodeCount             = C.NARSIL_GRAPH_WORD_NODE_COUNT
	GraphWordTombstoneCount        = C.NARSIL_GRAPH_WORD_TOMBSTONE_COUNT
	GraphWordUnlinkedNodes         = C.NARSIL_GRAPH_WORD_UNLINKED_NODES
	GraphWordUpperUsed             = C.NARSIL_GRAPH_WORD_UPPER_USED
	GraphWordSlots                 = C.NARSIL_GRAPH_WORD_SLOTS
	GraphWordUpperCapacity         = C.NARSIL_GRAPH_WORD_UPPER_CAPACITY
	GraphWordSlotCapacity          = C.NARSIL_GRAPH_WORD_SLOT_CAPACITY
	GraphWordLock                  = C.NARSIL_GRAPH_WORD_LOCK
	GraphWordWritersWaiting        = C.NARSIL_GRAPH_WORD_WRITERS_WAITING
	GraphWordEntryLock             = C.NARSIL_GRAPH_WORD_ENTRY_LOCK
	StoreWordSlots                 = C.NARSIL_STORE_WORD_SLOTS
	StoreWordLiveCount             = C.NARSIL_STORE_WORD_LIVE_COUNT
	StoreWordCalibrated            = C.NARSIL_STORE_WORD_CALIBRATED
	StoreWordCodeCount             = C.NARSIL_STORE_WORD_CODE_COUNT
	StoreWordCalibrationGeneration = C.NARSIL_STORE_WORD_CALIBRATION_GENERATION
	HeldWordNode                   = C.NARSIL_HELD_WORD_NODE
	HeldWordNodeValue              = C.NARSIL_HELD_WORD_NODE_VALUE
	HeldWordGraph                  = C.NARSIL_HELD_WORD_GRAPH
	HeldWordEntry                  = C.NARSIL_HELD_WORD_ENTRY
	VectorInABlock                 = C.NARSIL_VECTOR_IN_A_BLOCK
)

type Metric uint32

const (
	MetricCosine     Metric = C.NARSIL_METRIC_COSINE
	MetricDotProduct Metric = C.NARSIL_METRIC_DOT_PRODUCT
	MetricEuclidean  Metric = C.NARSIL_METRIC_EUCLIDEAN
)
