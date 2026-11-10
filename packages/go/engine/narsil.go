package engine

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

// Narsil is one search engine instance that holds named indexes in this
// process. Every method is safe to call from many goroutines at once: a
// query reads while a write to the same index proceeds, and writes to one
// index apply in the order that they arrive. Create one with New and release
// it with Shutdown.
type Narsil struct {
	config      model.Config
	idGenerator func() string

	lifeMu   sync.Mutex
	active   int
	retired  retirements
	closed   bool
	drained  chan struct{}
	shutdown sync.Once

	indexesMu  sync.RWMutex
	indexes    map[string]*indexEntry
	slots      map[string]*indexSlot
	names      *nameLocks
	recovering *recoveringEntries

	adapters *adapterRegistry
	events   *eventBus
	plugins  *pluginRunner
	workers  *queryPool
	heap     *heapWatch
	manager  *persist.Manager
	tier     model.DurabilityTier
	rerank   rerankSettings

	stopping      context.Context
	stop          context.CancelFunc
	sideBuildTurn chan struct{}

	syncRetention syncRetainer
	suggestions   *suggestionsRuntime
}

// New returns an engine built from config. With durability configured, New
// opens the write-ahead log directory or the persistence adapter and loads
// every index saved there before it returns, so the first call after New
// sees them. The context bounds that loading.
func New(ctx context.Context, config Config) (*Narsil, error) {
	engine := &Narsil{
		config:        config,
		idGenerator:   config.IDGenerator,
		drained:       make(chan struct{}),
		sideBuildTurn: make(chan struct{}, 1),
		indexes:       map[string]*indexEntry{},
		slots:         map[string]*indexSlot{},
		recovering:    &recoveringEntries{entries: map[string]*indexEntry{}},
		names:         newNameLocks(),
		events:        newEventBus(config.Events),
		plugins:       &pluginRunner{plugins: append([]model.Plugin(nil), config.Plugins...)},
	}
	if engine.idGenerator == nil {
		engine.idGenerator = generateDocumentID
	}
	if err := validateMemoryConfig(config.Memory); err != nil {
		return nil, err
	}
	if err := validateLifecycleConfig(config.Lifecycle, config.Workers); err != nil {
		return nil, err
	}
	rerank, err := resolveRerankSettings(config)
	if err != nil {
		return nil, err
	}
	engine.rerank = rerank
	registry, err := newAdapterRegistry(config)
	if err != nil {
		return nil, err
	}
	engine.adapters = registry
	pool, err := newQueryPool(config.Workers, engine.events)
	if err != nil {
		return nil, err
	}
	engine.workers = pool
	engine.heap = newHeapWatch(config.Memory, engine.events)
	engine.stopping, engine.stop = context.WithCancel(context.Background())
	if err := engine.openDurability(ctx); err != nil {
		engine.syncRetention.stop()
		engine.stop()
		engine.workers.close()
		return nil, err
	}
	if err := engine.startSuggestions(ctx); err != nil {
		_ = engine.Shutdown(context.WithoutCancel(ctx))
		return nil, err
	}
	engine.startSweeper()
	return engine, nil
}

func (n *Narsil) enter() (func(), error) {
	n.lifeMu.Lock()
	defer n.lifeMu.Unlock()
	if n.closed {
		return nil, narsilerr.New(narsilerr.CodeInstanceShutDown, "This Narsil instance has been shut down", nil)
	}
	n.active++
	generation := n.retired.enter()
	return func() { n.leave(generation) }, nil
}

func (n *Narsil) leave(generation uint64) {
	n.lifeMu.Lock()
	released := n.retired.leave(generation)
	n.lifeMu.Unlock()
	releaseIndexes(released)
	n.lifeMu.Lock()
	defer n.lifeMu.Unlock()
	n.active--
	if n.closed && n.active == 0 {
		close(n.drained)
	}
}

// Shutdown stops the engine: it refuses new calls with CodeInstanceShutDown,
// waits for calls already in progress, flushes and closes durable storage,
// stops the query workers, and shuts down every adapter that implements
// AdapterShutdown. When ctx ends first, Shutdown returns the context error
// and the engine finishes closing in the background. A second call returns
// nil at once.
func (n *Narsil) Shutdown(ctx context.Context) error {
	first := false
	n.shutdown.Do(func() {
		first = true
		n.stop()
		n.lifeMu.Lock()
		n.closed = true
		if n.active == 0 {
			close(n.drained)
		}
		n.lifeMu.Unlock()
	})
	if !first {
		return nil
	}
	finished := make(chan error, 1)
	go func() {
		<-n.drained
		finished <- n.release(context.WithoutCancel(ctx))
	}()
	select {
	case err := <-finished:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (n *Narsil) release(ctx context.Context) error {
	n.stopSuggestions(ctx)
	n.syncRetention.stop()
	var failures []error
	n.indexesMu.Lock()
	entries := make([]*indexEntry, 0, len(n.indexes))
	for _, entry := range n.indexes {
		entries = append(entries, entry)
	}
	n.indexes = map[string]*indexEntry{}
	n.slots = map[string]*indexSlot{}
	n.indexesMu.Unlock()
	if n.manager != nil {
		if err := n.manager.Close(ctx); err != nil {
			failures = append(failures, err)
		}
	}
	for _, entry := range entries {
		entry.retire()
		entry.dispose()
	}
	n.workers.close()
	failures = append(failures, n.adapters.shutdown(ctx)...)
	return errors.Join(failures...)
}

func indexNotFound(name string) error {
	return narsilerr.New(narsilerr.CodeIndexNotFound, `Index "`+name+`" does not exist`, map[string]any{"indexName": name})
}

func (n *Narsil) lookup(name string) (*indexEntry, bool) {
	n.indexesMu.RLock()
	defer n.indexesMu.RUnlock()
	entry, found := n.indexes[name]
	return entry, found
}

func (n *Narsil) acquire(name string) (*indexEntry, func(), error) {
	return n.acquireContext(context.Background(), name)
}

func (n *Narsil) acquireContext(ctx context.Context, name string) (*indexEntry, func(), error) {
	leave, err := n.enter()
	if err != nil {
		return nil, nil, err
	}
	for {
		slot, entry := n.slotOf(name)
		if entry != nil {
			entry.useMu.RLock()
			if !entry.retired {
				if slot != nil {
					slot.touch()
				}
				return entry, func() {
					entry.useMu.RUnlock()
					leave()
				}, nil
			}
			entry.useMu.RUnlock()
			continue
		}
		if slot == nil {
			leave()
			return nil, nil, indexNotFound(name)
		}
		if err := n.reopen(ctx, slot, false); err != nil {
			leave()
			return nil, nil, err
		}
		if slot.publicState() == model.IndexOpen {
			n.enforceOpenLimits(ctx, name)
		}
	}
}

func (n *Narsil) install(entry *indexEntry) {
	n.indexesMu.Lock()
	defer n.indexesMu.Unlock()
	n.indexes[entry.name] = entry
	slot, found := n.slots[entry.name]
	if !found {
		n.slots[entry.name] = newSlot(entry.name, slotOpen)
		return
	}
	slot.mu.Lock()
	slot.state = slotOpen
	slot.failures, slot.nextReopenAt, slot.cachedErr = 0, time.Time{}, nil
	slot.mu.Unlock()
	slot.touch()
}

func (n *Narsil) uninstall(entry *indexEntry) {
	n.indexesMu.Lock()
	defer n.indexesMu.Unlock()
	if n.indexes[entry.name] == entry {
		delete(n.indexes, entry.name)
	}
}

func (n *Narsil) sortedEntries() []*indexEntry {
	n.indexesMu.RLock()
	defer n.indexesMu.RUnlock()
	return valuesInNameOrder(n.indexes)
}

type nameLocks struct {
	mu    sync.Mutex
	locks map[string]*nameLock
}

type nameLock struct {
	mu    sync.Mutex
	users int
}

func (l *nameLocks) tryLock(name string) (func(), bool) {
	l.mu.Lock()
	held, found := l.locks[name]
	if !found {
		held = &nameLock{}
		l.locks[name] = held
	}
	held.users++
	l.mu.Unlock()
	release := func() {
		l.mu.Lock()
		held.users--
		if held.users == 0 {
			delete(l.locks, name)
		}
		l.mu.Unlock()
	}
	if !held.mu.TryLock() {
		release()
		return nil, false
	}
	return func() {
		held.mu.Unlock()
		release()
	}, true
}

func newNameLocks() *nameLocks {
	return &nameLocks{locks: map[string]*nameLock{}}
}

func (l *nameLocks) lock(name string) func() {
	l.mu.Lock()
	held, found := l.locks[name]
	if !found {
		held = &nameLock{}
		l.locks[name] = held
	}
	held.users++
	l.mu.Unlock()
	held.mu.Lock()
	return func() {
		held.mu.Unlock()
		l.mu.Lock()
		held.users--
		if held.users == 0 {
			delete(l.locks, name)
		}
		l.mu.Unlock()
	}
}
