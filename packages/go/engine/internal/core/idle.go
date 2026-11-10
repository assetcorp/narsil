package core

import (
	"runtime"
	"sync"
)

type idleList[T any] struct {
	mu   sync.Mutex
	held []T
}

func (l *idleList[T]) take() (T, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	count := len(l.held)
	if count == 0 {
		var none T
		return none, false
	}
	value := l.held[count-1]
	var cleared T
	l.held[count-1] = cleared
	l.held = l.held[:count-1]
	return value, true
}

func (l *idleList[T]) keep(value T) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.held) < runtime.GOMAXPROCS(0) {
		l.held = append(l.held, value)
	}
}
