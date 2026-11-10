package engine

import (
	"fmt"
	"runtime/debug"
	"runtime/metrics"
	"sync"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	heapLiveMetric   = "/memory/classes/heap/objects:bytes"
	memoryFullReason = "memory_full"
)

type heapWatch struct {
	block  float64
	resume float64
	events *eventBus

	mu         sync.Mutex
	measuredAt time.Time
	used       int64
	full       bool
	pressured  map[string]bool
}

func validateFraction(setting string, value model.Optional[float64]) error {
	held, set := value.Get()
	if !set || (held > 0 && held <= 1) {
		return nil
	}
	return narsilerr.New(narsilerr.CodeConfigInvalid, setting+" must be a number above 0 and at most 1",
		map[string]any{setting[len("memory."):]: held})
}

func validateMemoryConfig(config model.MemoryConfig) error {
	if err := validateFraction("memory.blockWritesAbove", config.BlockWritesAbove); err != nil {
		return err
	}
	if err := validateFraction("memory.resumeWritesBelow", config.ResumeWritesBelow); err != nil {
		return err
	}
	block := config.BlockWritesAbove.Or(defaultBlockWritesAbove)
	resume := config.ResumeWritesBelow.Or(defaultResumeWritesBelow)
	if resume >= block {
		return narsilerr.New(narsilerr.CodeConfigInvalid,
			fmt.Sprintf("memory.resumeWritesBelow (%v) must lie below blockWritesAbove (%v)", resume, block),
			map[string]any{"blockWritesAbove": block, "resumeWritesBelow": resume})
	}
	return nil
}

func newHeapWatch(config model.MemoryConfig, events *eventBus) *heapWatch {
	return &heapWatch{block: config.BlockWritesAbove.Or(defaultBlockWritesAbove),
		resume: config.ResumeWritesBelow.Or(defaultResumeWritesBelow), events: events, pressured: map[string]bool{}}
}

func heapLimit() (int64, bool) {
	limit := debug.SetMemoryLimit(-1)
	return limit, limit > 0 && limit < unlimitedMemoryLimit
}

func heapUsed() int64 {
	sample := []metrics.Sample{{Name: heapLiveMetric}}
	metrics.Read(sample)
	if sample[0].Value.Kind() != metrics.KindUint64 {
		return 0
	}
	return int64(sample[0].Value.Uint64())
}

func (watch *heapWatch) measure(limit int64) int64 {
	if time.Since(watch.measuredAt) < heapMeasureMaxAge && !watch.full {
		return watch.used
	}
	watch.used = heapUsed()
	watch.measuredAt = time.Now()
	if watch.full && float64(watch.used) < watch.resume*float64(limit) {
		watch.full = false
	}
	if !watch.full && float64(watch.used) >= watch.block*float64(limit) {
		watch.full = true
	}
	return watch.used
}

func (watch *heapWatch) admit(indexName string) error {
	limit, limited := heapLimit()
	if !limited {
		return nil
	}
	watch.mu.Lock()
	used := watch.measure(limit)
	full := watch.full
	watch.mu.Unlock()
	if !full {
		return nil
	}
	return narsilerr.New(narsilerr.CodeMemoryWriteBlocked,
		"The engine refuses inserts and updates to index '"+indexName+"' because its memory passed the block level of its limit. Remove documents to free memory, and writes resume once memory falls below the resume level.",
		map[string]any{"reason": memoryFullReason, "indexName": indexName, "processBytes": nil, "processLimitBytes": nil,
			"heapBytes": used, "heapLimitBytes": limit})
}

func (watch *heapWatch) check(indexName string, estimate func() (int64, error)) {
	limit, limited := heapLimit()
	if !limited {
		return
	}
	watch.mu.Lock()
	used := watch.measure(limit)
	warn := float64(used) >= heapPressureWarningFraction*float64(limit)
	rearm := float64(used) < heapPressureRearmFraction*float64(limit)
	emit := false
	switch {
	case warn && !watch.pressured[indexName]:
		watch.pressured[indexName] = true
		emit = true
	case rearm:
		delete(watch.pressured, indexName)
	}
	watch.mu.Unlock()
	if !emit {
		return
	}
	estimated, err := estimate()
	if err != nil {
		watch.mu.Lock()
		delete(watch.pressured, indexName)
		watch.mu.Unlock()
		return
	}
	watch.events.emit(model.HeapPressureEvent{IndexName: indexName, HeapUsed: used, HeapLimit: limit,
		EstimatedMemoryBytes: estimated})
}
