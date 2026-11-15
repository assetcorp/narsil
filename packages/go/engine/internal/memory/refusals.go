package memory

import (
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	MemoryFullReason          = "memory_full"
	WriteWouldFillMemory      = "write_would_fill_memory"
	writeExceedsMemoryReason  = "write_exceeds_memory"
	engineRefuser             = "The engine"
	engineOwner               = "the engine"
	retryOrRemoveDocumentsTip = "Retry once the writes in progress finish, or remove documents to free memory."
)

func bytesText(bytes float64) string {
	return strconv.FormatFloat(bytes, 'f', -1, 64)
}

func finiteOrNil(value float64) any {
	if math.IsInf(value, 0) || math.IsNaN(value) {
		return nil
	}
	return value
}

func MemoryFull(indexName string, figures Figures) error {
	return narsilerr.New(narsilerr.CodeMemoryWriteBlocked,
		"The engine refuses inserts and updates to index '"+indexName+"' because its memory passed the block level of its limit. Remove documents to free memory, and writes resume once memory falls below the resume level.",
		map[string]any{"reason": MemoryFullReason, "indexName": indexName,
			"processBytes": finiteOrNil(figures.ProcessBytes), "processLimitBytes": finiteOrNil(figures.ProcessLimitBytes),
			"heapBytes": finiteOrNil(figures.HeapBytes), "heapLimitBytes": finiteOrNil(figures.HeapLimitBytes)})
}

func IsMemoryFull(err error) bool {
	held, isEngineError := narsilerr.As(err)
	return isEngineError && held.Code == narsilerr.CodeMemoryWriteBlocked && held.Details["reason"] == MemoryFullReason
}

func exceedsMemory(indexName string, bound, blockBytes float64) error {
	return narsilerr.New(narsilerr.CodeMemoryWriteBlocked,
		engineRefuser+" refuses this document for index '"+indexName+"' because indexing it can take up to "+
			bytesText(bound)+" bytes, more than the "+bytesText(blockBytes)+" bytes that "+engineOwner+
			" allows its memory even when idle. Split the document into smaller documents.",
		map[string]any{"reason": writeExceedsMemoryReason, "indexName": indexName, "documentBytes": bound,
			"blockBytes": blockBytes})
}

type fillRefusal struct {
	indexName                 string
	bound                     float64
	projected                 float64
	figures                   Figures
	heapBytesBeforeCollection float64
	collectedGarbage          bool
	blockBytes                float64
}

func (r fillRefusal) err() error {
	return narsilerr.New(narsilerr.CodeMemoryWriteBlocked,
		engineRefuser+" refuses this document for index '"+r.indexName+"' because indexing it can take up to "+
			bytesText(r.bound)+" bytes, which with the "+bytesText(r.projected)+
			" bytes that writes in progress can take would pass "+engineOwner+"'s memory block. "+retryOrRemoveDocumentsTip,
		map[string]any{"reason": WriteWouldFillMemory, "indexName": r.indexName, "documentBytes": r.bound,
			"projectedBytes": r.projected, "heapBytes": r.figures.HeapBytes, "youngHeapBytes": float64(0),
			"heapBytesBeforeCollection": r.heapBytesBeforeCollection, "collectedGarbage": r.collectedGarbage,
			"processBytes": r.figures.ProcessBytes, "youngCeilingBytes": float64(0), "youngReserveBytes": float64(0),
			"blockBytes": r.blockBytes})
}

func RefusedAfter(indexName, docID, refusedDocID string) error {
	return narsilerr.New(narsilerr.CodeMemoryWriteBlocked,
		"The engine refuses document '"+docID+"' for index '"+indexName+"' because document '"+refusedDocID+
			"' before it in the batch would not fit in the engine's memory. Retry the refused documents once the writes in progress finish.",
		map[string]any{"reason": WriteWouldFillMemory, "indexName": indexName, "docId": docID,
			"refusedDocId": refusedDocID})
}
