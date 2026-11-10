package partition

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

type instance struct {
	state   *side
	readers atomic.Int64
}

type pair struct {
	writer    sync.Mutex
	instances [2]*instance
	active    atomic.Int32
	pending   []operation
	fields    []schema.Field
}

func newPair(fields []schema.Field, partialFields []string) *pair {
	left, right := newSide(), newSide()
	left.partial.AdoptFields(partialFields)
	right.partial.AdoptFields(partialFields)
	return &pair{instances: [2]*instance{{state: left}, {state: right}}, fields: fields}
}

func (p *pair) acquire() *instance {
	for {
		held := p.active.Load()
		current := p.instances[held]
		current.readers.Add(1)
		if p.active.Load() == held {
			return current
		}
		current.readers.Add(-1)
	}
}

func (p *pair) read(visit func(state *side)) {
	current := p.acquire()
	defer current.readers.Add(-1)
	visit(current.state)
}

func (p *pair) activeState() *side {
	return p.instances[p.active.Load()].state
}

func (p *pair) waitForReaders(stale *instance) {
	pause := firstReaderWait
	for stale.readers.Load() != 0 {
		time.Sleep(pause)
		pause = min(pause*2, longestReaderWait)
	}
}

func (p *pair) catchUp() *instance {
	stale := p.instances[1-p.active.Load()]
	p.waitForReaders(stale)
	if len(p.pending) > 0 {
		stale.state = stale.state.apply(p.pending, p.fields)
		p.pending = nil
	}
	return stale
}

func (p *pair) publish(operations []operation) {
	if len(operations) == 0 {
		return
	}
	stale := p.catchUp()
	stale.state = stale.state.apply(operations, p.fields)
	p.active.Store(1 - p.active.Load())
	p.pending = operations
}
