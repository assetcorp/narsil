package memory

import (
	"math"
	"sync"
)

type Reservation struct {
	once  sync.Once
	bytes float64
	Count int
}

func (r *Reservation) Release() {
	if r == nil || r.bytes == 0 {
		return
	}
	r.once.Do(func() {
		process.mu.Lock()
		process.reservedBytes -= r.bytes
		process.mu.Unlock()
	})
}

type CountExactly func(position int)

type Projection struct {
	monitor   *Monitor
	fractions Fractions
}

func NewProjection(monitor *Monitor) *Projection {
	return &Projection{monitor: monitor, fractions: monitor.fractions}
}

func (p *Projection) blockBytesOf(figures Figures) float64 {
	return math.Floor(math.Min(p.fractions.Block*figures.HeapLimitBytes, p.fractions.Block*figures.ProcessLimitBytes))
}

func (p *Projection) fittingLocked(figures Figures, bounds []float64, start, end int, burst float64) (int, int) {
	reserved := process.reservedBytes
	heapRoom := p.fractions.Block*figures.HeapLimitBytes - figures.HeapBytes - reserved
	processRoom := p.fractions.Block*figures.ProcessLimitBytes - figures.ProcessBytes - reserved
	taken := burst
	for position := start; position < end; position++ {
		next := taken + bounds[position]
		if next > heapRoom || next > processRoom {
			return position - start, position
		}
		taken = next
	}
	return end - start, -1
}

func reserveLocked(bounds []float64, start, count int, burst float64) *Reservation {
	bytes := burst
	for position := start; position < start+count; position++ {
		bytes += bounds[position]
	}
	process.reservedBytes += bytes
	process.admittedBytes += bytes
	return &Reservation{bytes: bytes, Count: count}
}

type countedPositions map[int]struct{}

func (c countedPositions) count(position int, countExactly CountExactly) bool {
	if _, done := c[position]; done || countExactly == nil {
		return false
	}
	c[position] = struct{}{}
	countExactly(position)
	return true
}

func (p *Projection) TakeGroup(indexName string, bounds []float64, start, mostDocuments int, burst float64,
	countExactly CountExactly) (*Reservation, error) {
	end := min(len(bounds), start+max(1, mostDocuments))
	if start >= end {
		return &Reservation{}, nil
	}
	burst = max(0, burst)
	counted := countedPositions{}
	for {
		process.mu.Lock()
		measured, found := process.recentLocked(WriteFiguresMaxAge)
		if !found {
			reservation := reserveLocked(bounds, start, end-start, burst)
			process.mu.Unlock()
			return reservation, nil
		}
		blockBytes := p.blockBytesOf(measured)
		if bounds[start] > blockBytes {
			process.mu.Unlock()
			if counted.count(start, countExactly) {
				continue
			}
			return nil, exceedsMemory(indexName, bounds[start], blockBytes)
		}
		count, stoppedAt := p.fittingLocked(measured, bounds, start, end, burst)
		if stoppedAt < 0 || (count > 0 && !p.countable(counted, stoppedAt, countExactly)) {
			reservation := reserveLocked(bounds, start, count, burst)
			process.mu.Unlock()
			return reservation, nil
		}
		process.mu.Unlock()
		if counted.count(stoppedAt, countExactly) {
			continue
		}
		reservation, refusal := p.afterCollection(indexName, bounds, start, end, burst, measured)
		if refusal != nil {
			return nil, refusal.err()
		}
		return reservation, nil
	}
}

func (p *Projection) countable(counted countedPositions, position int, countExactly CountExactly) bool {
	_, done := counted[position]
	return !done && countExactly != nil
}

func (p *Projection) afterCollection(indexName string, bounds []float64, start, end int, burst float64,
	measured Figures) (*Reservation, *fillRefusal) {
	collectionsBefore := p.monitor.Collections()
	figures, found := p.monitor.MeasureWithoutGarbage()
	if !found {
		figures = measured
	}
	process.mu.Lock()
	count, _ := p.fittingLocked(figures, bounds, start, end, burst)
	if count > 0 {
		reservation := reserveLocked(bounds, start, count, burst)
		process.mu.Unlock()
		return reservation, nil
	}
	projected := process.reservedBytes + burst
	process.mu.Unlock()
	collected := p.monitor.Collections() != collectionsBefore
	if collected {
		p.monitor.RefusedAfterCollection(figures)
	}
	return nil, &fillRefusal{indexName: indexName, bound: bounds[start], projected: projected, figures: figures,
		heapBytesBeforeCollection: measured.HeapBytes, collectedGarbage: collected,
		blockBytes: p.blockBytesOf(figures)}
}

func BurstBytes(freezingBytes, copiedBytes, tableBytes uint64) float64 {
	return float64(freezingBytes)*FreezePeakBytesPerGrowingByte + float64(copiedBytes)*SideCopyPeakBytesPerGrowingByte +
		float64(tableBytes)
}
