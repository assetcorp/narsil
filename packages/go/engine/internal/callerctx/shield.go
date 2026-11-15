package callerctx

import (
	"context"
	"sync/atomic"
	"time"
)

const (
	endingUnknown int32 = iota
	endingCanceled
	endingDeadline
)

var engineKeys []any

func EngineKey[K comparable](key K) K {
	engineKeys = append(engineKeys, key)
	return key
}

type shielded struct {
	caller      context.Context
	done        <-chan struct{}
	deadline    time.Time
	hasDeadline bool
	engine      []any
	ending      atomic.Int32
}

func Shield(caller context.Context) context.Context {
	if held, isShielded := caller.(*shielded); isShielded {
		return held
	}
	deadline, hasDeadline := caller.Deadline()
	values := make([]any, len(engineKeys))
	for at, key := range engineKeys {
		values[at] = caller.Value(key)
	}
	return &shielded{caller: caller, done: caller.Done(), deadline: deadline, hasDeadline: hasDeadline, engine: values}
}

func (s *shielded) Deadline() (time.Time, bool) {
	return s.deadline, s.hasDeadline
}

func (s *shielded) Done() <-chan struct{} {
	return s.done
}

func (s *shielded) Err() error {
	select {
	case <-s.done:
	default:
		return nil
	}
	observed := endingCanceled
	if s.hasDeadline && !time.Now().Before(s.deadline) {
		observed = endingDeadline
	}
	s.ending.CompareAndSwap(endingUnknown, observed)
	if s.ending.Load() == endingDeadline {
		return context.DeadlineExceeded
	}
	return context.Canceled
}

func (s *shielded) Value(key any) any {
	for at, engineKey := range engineKeys {
		if engineKey == key {
			return s.engine[at]
		}
	}
	return s.caller.Value(key)
}
