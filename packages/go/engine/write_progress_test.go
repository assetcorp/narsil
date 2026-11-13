package engine_test

import "sync/atomic"

type writeProgress struct {
	completed atomic.Int64
	every     int64
	ready     chan struct{}
}

func newWriteProgress(every int64) *writeProgress {
	return &writeProgress{every: every, ready: make(chan struct{}, 1)}
}

func (progress *writeProgress) record() {
	if progress.completed.Add(1)%progress.every != 0 {
		return
	}
	select {
	case progress.ready <- struct{}{}:
	default:
	}
}

func (progress *writeProgress) await(round int, stop <-chan struct{}) bool {
	required := int64(round+1) * progress.every
	for progress.completed.Load() < required {
		select {
		case <-stop:
			return progress.completed.Load() >= required
		case <-progress.ready:
		}
	}
	return true
}
