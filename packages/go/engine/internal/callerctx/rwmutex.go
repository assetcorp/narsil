package callerctx

import (
	"context"
	"slices"
	"sync"
)

type writerTurn struct {
	_ byte
}

type RWMutex struct {
	mu      sync.Mutex
	readers int
	writing bool
	queued  []*writerTurn
	changed chan struct{}
}

func (m *RWMutex) notify() {
	if m.changed != nil {
		close(m.changed)
		m.changed = nil
	}
}

func (m *RWMutex) wait(stopped <-chan struct{}) bool {
	if m.changed == nil {
		m.changed = make(chan struct{})
	}
	changed := m.changed
	m.mu.Unlock()
	defer m.mu.Lock()
	select {
	case <-stopped:
		return false
	case <-changed:
		return true
	}
}

func (m *RWMutex) leaveQueue(turn *writerTurn) {
	if at := slices.Index(m.queued, turn); at >= 0 {
		m.queued = slices.Delete(m.queued, at, at+1)
	}
	m.notify()
}

func (m *RWMutex) LockContext(ctx context.Context) error {
	stopped := ctx.Done()
	m.mu.Lock()
	defer m.mu.Unlock()
	select {
	case <-stopped:
		return ctx.Err()
	default:
	}
	if !m.writing && m.readers == 0 && len(m.queued) == 0 {
		m.writing = true
		return nil
	}
	turn := &writerTurn{}
	m.queued = append(m.queued, turn)
	for {
		select {
		case <-stopped:
			m.leaveQueue(turn)
			return ctx.Err()
		default:
		}
		if !m.writing && m.readers == 0 && m.queued[0] == turn {
			m.queued = m.queued[1:]
			m.writing = true
			return nil
		}
		if !m.wait(stopped) {
			m.leaveQueue(turn)
			return ctx.Err()
		}
	}
}

func (m *RWMutex) RLockContext(ctx context.Context) error {
	stopped := ctx.Done()
	m.mu.Lock()
	defer m.mu.Unlock()
	for {
		select {
		case <-stopped:
			return ctx.Err()
		default:
		}
		if !m.writing && len(m.queued) == 0 {
			m.readers++
			return nil
		}
		if !m.wait(stopped) {
			return ctx.Err()
		}
	}
}

func (m *RWMutex) Lock() {
	_ = m.LockContext(context.Background())
}

func (m *RWMutex) RLock() {
	_ = m.RLockContext(context.Background())
}

func (m *RWMutex) TryLock() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.writing || m.readers != 0 || len(m.queued) != 0 {
		return false
	}
	m.writing = true
	return true
}

func (m *RWMutex) Unlock() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.writing {
		panic("unlock of an unlocked index")
	}
	m.writing = false
	m.notify()
}

func (m *RWMutex) RUnlock() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.readers == 0 {
		panic("read unlock of an unlocked index")
	}
	m.readers--
	if m.readers == 0 {
		m.notify()
	}
}
