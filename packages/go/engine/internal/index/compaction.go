package index

import (
	"sync"
	"sync/atomic"
	"time"
)

type compactionScheduler struct {
	mu        sync.Mutex
	timer     *time.Timer
	quietAt   time.Time
	running   bool
	finished  chan struct{}
	idleDue   bool
	ingestDue bool
	stopped   atomic.Bool
}

func (ix *Index) noteGrowth() {
	if ix.settings.TextOnDisk {
		return
	}
	s := &ix.compactions
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped.Load() {
		return
	}
	s.quietAt = time.Now().Add(idleMergeDelay)
	if s.timer == nil {
		ix.armIdleMergeLocked(idleMergeDelay)
	}
	s.ingestDue = true
	ix.startCompactionsLocked()
}

func (ix *Index) armIdleMergeLocked(delay time.Duration) {
	s := &ix.compactions
	var timer *time.Timer
	timer = time.AfterFunc(delay, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.timer != timer || s.stopped.Load() {
			return
		}
		if remaining := time.Until(s.quietAt); remaining > 0 {
			ix.armIdleMergeLocked(remaining)
			return
		}
		s.timer = nil
		s.idleDue = true
		ix.startCompactionsLocked()
	})
	s.timer = timer
}

func (ix *Index) startCompactionsLocked() {
	s := &ix.compactions
	if s.running {
		return
	}
	s.running = true
	s.finished = make(chan struct{})
	go ix.runCompactions(s.finished)
}

func (s *compactionScheduler) takeLocked() (CompactionPolicy, bool) {
	switch {
	case s.idleDue:
		s.idleDue, s.ingestDue = false, false
		return CompactWhileIdle, true
	case s.ingestDue:
		s.ingestDue = false
		return CompactWhileIngesting, true
	}
	return CompactWhileIngesting, false
}

func (ix *Index) runCompactions(finished chan struct{}) {
	s := &ix.compactions
	defer close(finished)
	for {
		s.mu.Lock()
		policy, due := s.takeLocked()
		if !due || s.stopped.Load() {
			s.running = false
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()
		_, _ = ix.compactSegments(policy, s.stopped.Load)
	}
}

func (ix *Index) StopCompactions() {
	s := &ix.compactions
	s.mu.Lock()
	s.stopped.Store(true)
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	running, finished := s.running, s.finished
	s.mu.Unlock()
	if running {
		<-finished
	}
}
