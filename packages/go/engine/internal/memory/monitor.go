package memory

import (
	"math"
	"sync"
	"time"
)

type Fractions struct {
	Block  float64
	Resume float64
}

type Monitor struct {
	fractions Fractions

	mu               sync.Mutex
	latest           Figures
	measured         bool
	full             bool
	sampledAt        time.Time
	collectedAt      time.Time
	collectionCount  int
	sampledOnce      bool
	collectedOnce    bool
	refusalCollector *refusalCollector
}

func NewMonitor(fractions Fractions) *Monitor {
	return &Monitor{fractions: fractions, refusalCollector: beforeRefusal}
}

func fractionOf(used, limit float64) float64 {
	if limit > 0 && !math.IsInf(limit, 1) {
		return used / limit
	}
	return 0
}

func (m *Monitor) atOrAboveResume(figures Figures) bool {
	return fractionOf(figures.ProcessBytes, figures.ProcessLimitBytes) >= m.fractions.Resume ||
		fractionOf(figures.HeapBytes, figures.HeapLimitBytes) >= m.fractions.Resume
}

func (m *Monitor) nextFull(wasFull bool, figures Figures) bool {
	if wasFull {
		return m.atOrAboveResume(figures)
	}
	return fractionOf(figures.ProcessBytes, figures.ProcessLimitBytes) > m.fractions.Block ||
		fractionOf(figures.HeapBytes, figures.HeapLimitBytes) > m.fractions.Block
}

func (m *Monitor) withoutGarbageLocked(figures Figures) Figures {
	now := time.Now()
	if m.collectedOnce && now.Sub(m.collectedAt) < fullCollectionInterval {
		return figures
	}
	m.collectedAt, m.collectedOnce = now, true
	if !collectGarbage() {
		return figures
	}
	m.collectionCount++
	if fresh, found := process.measure(); found {
		return fresh
	}
	return figures
}

func (m *Monitor) recordLocked(figures Figures, found bool) {
	if !found {
		m.measured, m.full = false, false
		return
	}
	wasFull := m.full
	full := m.nextFull(wasFull, figures)
	if full {
		figures = m.withoutGarbageLocked(figures)
		full = m.nextFull(wasFull, figures)
	}
	m.latest, m.measured, m.full = figures, true, full
}

func (m *Monitor) sampleLocked() {
	m.sampledAt, m.sampledOnce = time.Now(), true
	m.recordLocked(process.measure())
}

func (m *Monitor) measureIfOlderThanLocked(maxAge time.Duration) {
	if !m.sampledOnce || time.Since(m.sampledAt) >= maxAge {
		m.sampleLocked()
	}
}

func (m *Monitor) measureWithoutGarbageLocked() (Figures, bool) {
	m.sampledAt, m.sampledOnce = time.Now(), true
	figures, found := process.measure()
	if !found {
		return m.latest, m.measured
	}
	if m.refusalCollector.collect() {
		m.collectionCount++
		if fresh, freshFound := process.measure(); freshFound {
			figures = fresh
		}
	}
	m.recordLocked(figures, true)
	return m.latest, true
}

func (m *Monitor) MeasureWithoutGarbage() (Figures, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.measureWithoutGarbageLocked()
}

func (m *Monitor) Collections() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.collectionCount
}

func (m *Monitor) RefusedAfterCollection(figures Figures) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.full || !m.atOrAboveResume(figures) {
		return
	}
	m.latest, m.measured, m.full = figures, true, true
}

func (m *Monitor) MemoryReleased() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.full {
		m.collectedOnce, m.sampledOnce = false, false
	}
}

type FullReport struct {
	Full    bool
	Figures Figures
}

func (m *Monitor) CheckFull() FullReport {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.measureIfOlderThanLocked(WriteFiguresMaxAge)
	if !m.full {
		return FullReport{}
	}
	m.measureWithoutGarbageLocked()
	if !m.full {
		return FullReport{}
	}
	return FullReport{Full: true, Figures: m.latest}
}
