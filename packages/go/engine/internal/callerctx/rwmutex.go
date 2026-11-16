package callerctx

import (
	"context"
	"runtime"
	"slices"
	"sync"
)

type writerTurn struct {
	granted chan struct{}
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

func (m *RWMutex) handOff() bool {
	if m.writing {
		return false
	}
	if len(m.queued) == 0 {
		m.notify()
		return false
	}
	if m.readers != 0 {
		return false
	}
	turn := m.queued[0]
	m.queued = m.queued[1:]
	m.writing = true
	close(turn.granted)
	return true
}

func (m *RWMutex) abandonTurn(turn *writerTurn) {
	m.mu.Lock()
	defer m.mu.Unlock()
	select {
	case <-turn.granted:
		m.writing = false
	default:
		if at := slices.Index(m.queued, turn); at >= 0 {
			m.queued = slices.Delete(m.queued, at, at+1)
		}
	}
	m.handOff()
}

func (m *RWMutex) LockContext(ctx context.Context) error {
	stopped := ctx.Done()
	m.mu.Lock()
	select {
	case <-stopped:
		m.mu.Unlock()
		return ctx.Err()
	default:
	}
	if !m.writing && m.readers == 0 && len(m.queued) == 0 {
		m.writing = true
		m.mu.Unlock()
		return nil
	}
	turn := &writerTurn{granted: make(chan struct{})}
	m.queued = append(m.queued, turn)
	m.mu.Unlock()
	select {
	case <-turn.granted:
		return nil
	case <-stopped:
		m.abandonTurn(turn)
		return ctx.Err()
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
	if !m.writing {
		m.mu.Unlock()
		panic("unlock of an unlocked index")
	}
	m.writing = false
	granted := m.handOff()
	m.mu.Unlock()
	if granted {
		runtime.Gosched()
	}
}

func (m *RWMutex) RUnlock() {
	m.mu.Lock()
	if m.readers == 0 {
		m.mu.Unlock()
		panic("read unlock of an unlocked index")
	}
	m.readers--
	granted := m.handOff()
	m.mu.Unlock()
	if granted {
		runtime.Gosched()
	}
}
