package memory

import (
	"math"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	heapBudget    = "heap"
	processBudget = "process"
)

type restoreRate struct {
	perStoredByte      float64
	perVector          float64
	perVectorDimension float64
}

type restoreRates struct {
	heap    restoreRate
	process restoreRate
}

type restorePathRates struct {
	worst restoreRates
	floor restoreRates
}

var archiveRestoreRates = restorePathRates{
	worst: restoreRates{
		heap: restoreRate{restoreWorstHeapBytesPerStoredByte, restoreWorstHeapBytesPerVector,
			restoreWorstHeapBytesPerVectorDimension},
		process: restoreRate{restoreWorstProcessBytesPerStoredByte, restoreWorstProcessBytesPerVector,
			restoreWorstProcessBytesPerVectorDimension},
	},
	floor: restoreRates{
		heap: restoreRate{restoreFloorHeapBytesPerStoredByte, restoreFloorHeapBytesPerVector,
			restoreFloorHeapBytesPerVectorDimension},
		process: restoreRate{restoreFloorProcessBytesPerStoredByte, restoreFloorProcessBytesPerVector,
			restoreFloorProcessBytesPerVectorDimension},
	},
}

var pagedRestoreRates = restorePathRates{
	worst: restoreRates{
		heap: restoreRate{restoreWorstHeapBytesPerPagedStoredByte, restoreWorstHeapBytesPerVector,
			restoreWorstHeapBytesPerVectorDimension},
		process: restoreRate{restoreWorstProcessBytesPerPagedStoredByte, restoreWorstProcessBytesPerVector,
			restoreWorstProcessBytesPerVectorDimension},
	},
	floor: restoreRates{
		heap: restoreRate{restoreFloorHeapBytesPerPagedStoredByte, restoreFloorHeapBytesPerVector,
			restoreFloorHeapBytesPerVectorDimension},
		process: restoreRate{restoreFloorProcessBytesPerPagedStoredByte, restoreFloorProcessBytesPerVector,
			restoreFloorProcessBytesPerVectorDimension},
	},
}

var earlierRestoreRates = restorePathRates{
	worst: restoreRates{
		heap: restoreRate{restoreWorstHeapBytesPerEarlierByte, restoreWorstHeapBytesPerEarlierVector,
			restoreWorstHeapBytesPerEarlierDimension},
		process: restoreRate{restoreWorstProcessBytesPerEarlierByte, restoreWorstProcessBytesPerEarlierVector,
			restoreWorstProcessBytesPerEarlierDimension},
	},
	floor: restoreRates{
		heap: restoreRate{restoreFloorHeapBytesPerEarlierByte, restoreFloorHeapBytesPerEarlierVector,
			restoreFloorHeapBytesPerEarlierDimension},
		process: restoreRate{restoreFloorProcessBytesPerEarlierByte, restoreFloorProcessBytesPerEarlierVector,
			restoreFloorProcessBytesPerEarlierDimension},
	},
}

type VectorCount struct {
	Dimension float64
	Count     float64
}

type RestoreSize struct {
	StoredBytes float64
	Vectors     []VectorCount
	TextOnDisk  bool
	Earlier     bool
}

type footprint struct {
	heapBytes    float64
	processBytes float64
}

func (rate restoreRate) bytesFor(size RestoreSize) float64 {
	bytes := size.StoredBytes * rate.perStoredByte
	for _, vectors := range size.Vectors {
		bytes += vectors.Count * (rate.perVector + vectors.Dimension*rate.perVectorDimension)
	}
	return bytes
}

func restoreFootprint(size RestoreSize, replacesIndex bool) footprint {
	rates := archiveRestoreRates
	switch {
	case size.Earlier:
		rates = earlierRestoreRates
	case size.TextOnDisk:
		rates = pagedRestoreRates
	}
	chosen, scale := rates.floor, 1/restoreEstimateMargin
	if replacesIndex {
		chosen, scale = rates.worst, restoreEstimateMargin
	}
	return footprint{heapBytes: chosen.heap.bytesFor(size) * scale, processBytes: chosen.process.bytesFor(size) * scale}
}

type shortfall struct {
	budget         string
	neededBytes    float64
	availableBytes float64
}

func shortfallOf(heapBytes, processBytes float64) (shortfall, bool) {
	figures, found := process.measure()
	if !found {
		return shortfall{}, false
	}
	if !math.IsInf(figures.HeapLimitBytes, 1) {
		available := figures.HeapLimitBytes - figures.HeapBytes
		if heapBytes > available {
			return shortfall{budget: heapBudget, neededBytes: heapBytes, availableBytes: available}, true
		}
	}
	if !math.IsInf(figures.ProcessLimitBytes, 1) {
		available := figures.ProcessLimitBytes - figures.ProcessBytes
		if processBytes > available {
			return shortfall{budget: processBudget, neededBytes: processBytes, availableBytes: available}, true
		}
	}
	return shortfall{}, false
}

func inMegabytes(bytes float64) string {
	return strconv.FormatFloat(math.Ceil(max(0, bytes)/mebibyteBytes), 'f', 0, 64)
}

func RequireRestoreMemory(indexName string, size RestoreSize, replacesIndex bool) error {
	needed := restoreFootprint(size, replacesIndex)
	if _, short := shortfallOf(needed.heapBytes, needed.processBytes); !short {
		return nil
	}
	collectGarbage()
	found, short := shortfallOf(needed.heapBytes, needed.processBytes)
	if !short {
		return nil
	}
	where := "of process memory"
	if found.budget == heapBudget {
		where = "of Go heap"
	}
	outcome := "so the engine creates no index. Give the process more memory, then restore again"
	if replacesIndex {
		outcome = "so the index keeps its earlier contents. Drop the index first to free the memory that it holds, or give the process more memory, then restore again"
	}
	return narsilerr.New(narsilerr.CodeRestoreMemoryExceeded,
		`The restore of index "`+indexName+`" needs about `+inMegabytes(found.neededBytes)+" MB "+where+
			", and this process has "+inMegabytes(found.availableBytes)+" MB free, "+outcome,
		map[string]any{"indexName": indexName, "budget": found.budget, "neededBytes": found.neededBytes,
			"availableBytes": found.availableBytes})
}
