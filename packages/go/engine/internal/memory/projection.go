package memory

import (
	"math"
	"sync"
)

type heldBurst struct {
	bytes   float64
	holders int
}

type Reservation struct {
	once     sync.Once
	bytes    float64
	burstKey any
	Count    int
}

func (r *Reservation) Release() {
	if r == nil || (r.bytes == 0 && r.burstKey == nil) {
		return
	}
	r.once.Do(func() {
		process.mu.Lock()
		defer process.mu.Unlock()
		process.reservedBytes -= r.bytes
		process.completedBytes += r.bytes
		if r.burstKey == nil {
			return
		}
		held := process.bursts[r.burstKey]
		if held == nil {
			return
		}
		if held.holders--; held.holders <= 0 {
			process.completedBytes += held.bytes
			delete(process.bursts, r.burstKey)
		}
	})
}

type CountExactly func(position int)

type Burst struct {
	Key   any
	Bytes float64
}

func (c *figureCache) reservedLocked() float64 {
	reserved := c.reservedBytes
	for _, held := range c.bursts {
		reserved += held.bytes
	}
	return reserved
}

func (c *figureCache) extraBurstLocked(burst Burst) float64 {
	if burst.Key == nil || burst.Bytes <= 0 {
		return 0
	}
	if held := c.bursts[burst.Key]; held != nil {
		return max(0, burst.Bytes-held.bytes)
	}
	return burst.Bytes
}

type Projection struct {
	monitor *Monitor
}

func NewProjection(monitor *Monitor) *Projection {
	return &Projection{monitor: monitor}
}

func (p *Projection) blockBytesOf(figures Figures) float64 {
	block := p.monitor.fractions.Block
	return math.Floor(math.Min(block*figures.HeapLimitBytes, block*figures.ProcessLimitBytes))
}

func (p *Projection) fittingLocked(figures Figures, bounds []float64, start, end int, burst Burst) (int, int) {
	block := p.monitor.fractions.Block
	reserved := process.reservedLocked()
	heapRoom := block*figures.HeapLimitBytes - figures.HeapBytes - reserved
	processRoom := block*figures.ProcessLimitBytes - figures.ProcessBytes - reserved
	taken := process.extraBurstLocked(burst)
	for position := start; position < end; position++ {
		next := taken + bounds[position]
		if next > heapRoom || next > processRoom {
			return position - start, position
		}
		taken = next
	}
	return end - start, -1
}

func reserveLocked(bounds []float64, start, count int, burst Burst) *Reservation {
	bytes := 0.0
	for position := start; position < start+count; position++ {
		bytes += bounds[position]
	}
	reservation := &Reservation{bytes: bytes, Count: count}
	process.reservedBytes += bytes
	if burst.Key != nil && burst.Bytes > 0 {
		if process.bursts == nil {
			process.bursts = map[any]*heldBurst{}
		}
		held := process.bursts[burst.Key]
		if held == nil {
			held = &heldBurst{}
			process.bursts[burst.Key] = held
		}
		held.bytes = max(held.bytes, burst.Bytes)
		held.holders++
		reservation.burstKey = burst.Key
	}
	return reservation
}

type countedPositions map[int]struct{}

func (c countedPositions) counted(position int) bool {
	_, done := c[position]
	return done
}

func (c countedPositions) count(position int, countExactly CountExactly) bool {
	if countExactly == nil || c.counted(position) {
		return false
	}
	c[position] = struct{}{}
	countExactly(position)
	return true
}

func (p *Projection) TakeGroup(indexName string, bounds []float64, start, mostDocuments int, burst Burst,
	countExactly CountExactly) (*Reservation, error) {
	end := min(len(bounds), start+max(1, mostDocuments))
	if start >= end {
		return &Reservation{}, nil
	}
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
		if stoppedAt < 0 || (count > 0 && (countExactly == nil || counted.counted(stoppedAt))) {
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

func (p *Projection) afterCollection(indexName string, bounds []float64, start, end int, burst Burst,
	measured Figures) (*Reservation, *fillRefusal) {
	collectionsBefore := p.monitor.Collections()
	figures, found := p.monitor.MeasureWithoutGarbage()
	if !found {
		figures = measured
	}
	process.mu.Lock()
	if recent, available := process.recentLocked(WriteFiguresMaxAge); available {
		figures = recent
	}
	count, _ := p.fittingLocked(figures, bounds, start, end, burst)
	if count > 0 {
		reservation := reserveLocked(bounds, start, count, burst)
		process.mu.Unlock()
		return reservation, nil
	}
	projected := process.reservedLocked() + process.extraBurstLocked(burst)
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
