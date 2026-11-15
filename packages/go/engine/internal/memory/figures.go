package memory

import (
	"math"
	"runtime/debug"
	"runtime/metrics"
	"sync"
	"time"
)

const (
	runtimeTotalMetric    = "/memory/classes/total:bytes"
	runtimeReleasedMetric = "/memory/classes/heap/released:bytes"
)

type Figures struct {
	ProcessBytes      float64
	ProcessLimitBytes float64
	HeapBytes         float64
	HeapLimitBytes    float64
}

func (f Figures) smallestLimit() float64 {
	return math.Min(f.ProcessLimitBytes, f.HeapLimitBytes)
}

type figureCache struct {
	mu              sync.Mutex
	latest          Figures
	measured        bool
	readAt          time.Time
	completedAtRead float64
	limitBytes      uint64
	limitKnown      bool
	limitReadAt     time.Time
	reservedBytes   float64
	bursts          map[any]*heldBurst
	completedBytes  float64
}

var process = &figureCache{}

func goHeap() (float64, float64, bool) {
	limit := debug.SetMemoryLimit(-1)
	if limit <= 0 || limit == math.MaxInt64 {
		return 0, 0, false
	}
	samples := []metrics.Sample{{Name: runtimeTotalMetric}, {Name: runtimeReleasedMetric}}
	metrics.Read(samples)
	if samples[0].Value.Kind() != metrics.KindUint64 || samples[1].Value.Kind() != metrics.KindUint64 {
		return 0, 0, false
	}
	total, released := samples[0].Value.Uint64(), samples[1].Value.Uint64()
	return float64(total - min(total, released)), float64(limit), true
}

func collectGarbage() {
	debug.FreeOSMemory()
}

func (c *figureCache) processFigures(now time.Time) (uint64, uint64, bool) {
	processBytes, found := platformProcessBytes()
	if !found {
		return 0, 0, false
	}
	if !c.limitKnown || now.Sub(c.limitReadAt) >= processLimitRefreshInterval {
		c.limitBytes, c.limitKnown = platformLimitBytes(processBytes)
		c.limitReadAt = now
	}
	if !c.limitKnown || c.limitBytes == 0 {
		return 0, 0, false
	}
	return processBytes, c.limitBytes, true
}

func (c *figureCache) readFreshLocked() (Figures, bool) {
	now := time.Now()
	figures := Figures{ProcessLimitBytes: math.Inf(1), HeapLimitBytes: math.Inf(1)}
	processBytes, limitBytes, processKnown := c.processFigures(now)
	if processKnown {
		figures.ProcessBytes, figures.ProcessLimitBytes = float64(processBytes), float64(limitBytes)
	}
	heapBytes, heapLimit, heapKnown := goHeap()
	if heapKnown {
		figures.HeapBytes, figures.HeapLimitBytes = heapBytes, heapLimit
	}
	c.latest, c.measured = figures, processKnown || heapKnown
	c.readAt = now
	c.completedAtRead = c.completedBytes
	return figures, c.measured
}

func (c *figureCache) measure() (Figures, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.readFreshLocked()
}

func (c *figureCache) recentLocked(maxAge time.Duration) (Figures, bool) {
	completedSince := c.completedBytes - c.completedAtRead
	if !c.measured || time.Since(c.readAt) >= maxAge ||
		completedSince > recentFiguresMaxCompletedFraction*c.latest.smallestLimit() {
		return c.readFreshLocked()
	}
	recent := c.latest
	recent.ProcessBytes += completedSince
	recent.HeapBytes += completedSince
	return recent, true
}

type refusalCollector struct {
	mu        sync.Mutex
	lastAt    time.Time
	collected bool
	interval  time.Duration
}

func (r *refusalCollector) collect() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	startedAt := time.Now()
	if r.collected && startedAt.Sub(r.lastAt) < r.interval {
		return false
	}
	r.lastAt, r.collected = startedAt, true
	collectGarbage()
	r.interval = max(refusalCollectionMinInterval, time.Since(startedAt)*refusalCollectionTimeMultiple)
	return true
}

var beforeRefusal = &refusalCollector{interval: refusalCollectionMinInterval}
