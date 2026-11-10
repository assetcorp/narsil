package engine

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type slotState uint8

const (
	slotOpen slotState = iota
	slotClosed
	slotClosing
	slotReopenFailed
)

type closedSummary struct {
	documentCount  int
	partitionCount int
	language       string
	schema         model.Schema
	config         model.IndexConfig
	suggestions    is.QuerySuggestionsState
}

type transition struct {
	done chan struct{}
	err  error
}

type indexSlot struct {
	name       string
	lastAccess atomic.Int64

	mu           sync.Mutex
	state        slotState
	summary      closedSummary
	reopenCount  int
	failures     int
	nextReopenAt time.Time
	cachedErr    error
	reopening    *transition
	waiters      int
}

func (slot *indexSlot) touch() {
	slot.lastAccess.Store(time.Now().UnixNano())
}

func (slot *indexSlot) publicState() model.IndexState {
	slot.mu.Lock()
	defer slot.mu.Unlock()
	switch slot.state {
	case slotClosed:
		return model.IndexClosed
	case slotReopenFailed:
		return model.IndexReopenFailed
	default:
		return model.IndexOpen
	}
}

func (slot *indexSlot) reopens() int {
	slot.mu.Lock()
	defer slot.mu.Unlock()
	return slot.reopenCount
}

func (slot *indexSlot) closedView() (closedSummary, bool) {
	slot.mu.Lock()
	defer slot.mu.Unlock()
	return slot.summary, slot.state == slotClosed || slot.state == slotReopenFailed
}

func newSlot(name string, state slotState) *indexSlot {
	slot := &indexSlot{name: name, state: state}
	slot.touch()
	return slot
}

func summaryOf(entry *indexEntry) closedSummary {
	return closedSummary{
		documentCount:  entry.index().Count(),
		partitionCount: entry.index().PartitionCount(),
		language:       entry.currentAnalysis().language,
		schema:         entry.parsed.Schema(),
		config:         entry.currentConfig(),
		suggestions:    entry.suggestions.current(),
	}
}

func (n *Narsil) slotOf(name string) (*indexSlot, *indexEntry) {
	n.indexesMu.RLock()
	defer n.indexesMu.RUnlock()
	return n.slots[name], n.indexes[name]
}

func (n *Narsil) known(name string) bool {
	n.indexesMu.RLock()
	defer n.indexesMu.RUnlock()
	_, found := n.slots[name]
	return found
}

func (n *Narsil) registerClosed(name string, summary closedSummary) {
	slot := newSlot(name, slotClosed)
	slot.summary = summary
	n.indexesMu.Lock()
	n.slots[name] = slot
	n.indexesMu.Unlock()
}

func (n *Narsil) forgetSlot(name string, slot *indexSlot) {
	n.indexesMu.Lock()
	defer n.indexesMu.Unlock()
	if n.slots[name] == slot {
		delete(n.slots, name)
	}
}

func cachedRecoveryError(err error, name string) error {
	if _, ok := narsilerr.As(err); ok {
		return err
	}
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, fmt.Sprintf("Index %q could not be reopened", name),
		map[string]any{"indexName": name, "cause": err.Error()})
}

func (n *Narsil) reopenWaiterLimit() int {
	if n.config.Lifecycle == nil {
		return defaultMaxReopenWaiters
	}
	return n.config.Lifecycle.MaxReopenWaiters.Or(defaultMaxReopenWaiters)
}

func waitTransition(ctx context.Context, step *transition) error {
	select {
	case <-step.done:
		return step.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (n *Narsil) reopen(ctx context.Context, slot *indexSlot, explicit bool) error {
	slot.mu.Lock()
	if slot.state == slotOpen || slot.state == slotClosing {
		slot.mu.Unlock()
		return nil
	}
	if explicit {
		slot.failures, slot.nextReopenAt, slot.cachedErr = 0, time.Time{}, nil
		if slot.state == slotReopenFailed {
			slot.state = slotClosed
		}
	}
	if slot.state == slotReopenFailed {
		err := slot.cachedErr
		slot.mu.Unlock()
		return err
	}
	if pending := slot.reopening; pending != nil {
		if slot.waiters >= n.reopenWaiterLimit() {
			slot.mu.Unlock()
			return narsilerr.New(narsilerr.CodeIndexReopenCapacityExhausted,
				fmt.Sprintf("Index %q has reached its reopen waiter limit", slot.name),
				map[string]any{"indexName": slot.name, "maximum": n.reopenWaiterLimit()})
		}
		slot.waiters++
		slot.mu.Unlock()
		err := waitTransition(ctx, pending)
		slot.mu.Lock()
		slot.waiters--
		slot.mu.Unlock()
		return err
	}
	if !explicit && slot.cachedErr != nil && time.Now().Before(slot.nextReopenAt) {
		err := slot.cachedErr
		slot.mu.Unlock()
		return err
	}
	step := &transition{done: make(chan struct{})}
	slot.reopening = step
	slot.mu.Unlock()
	leave, err := n.enter()
	if err != nil {
		slot.mu.Lock()
		slot.reopening = nil
		slot.mu.Unlock()
		return err
	}
	go func() {
		defer leave()
		n.runReopen(slot, step)
	}()
	return waitTransition(ctx, step)
}

func (n *Narsil) runReopen(slot *indexSlot, step *transition) {
	err := n.loadClosedIndex(n.stopping, slot)
	slot.mu.Lock()
	if err == nil {
		slot.state = slotOpen
		slot.reopenCount++
		slot.failures, slot.nextReopenAt, slot.cachedErr = 0, time.Time{}, nil
	} else {
		slot.failures++
		slot.cachedErr = cachedRecoveryError(err, slot.name)
		slot.nextReopenAt = time.Now().Add(reopenBackoffBase << (slot.failures - 1))
		if slot.failures >= maxReopenFailures {
			slot.state = slotReopenFailed
		} else {
			slot.state = slotClosed
		}
		err = slot.cachedErr
	}
	step.err = err
	slot.reopening = nil
	slot.mu.Unlock()
	close(step.done)
}

func (n *Narsil) loadClosedIndex(ctx context.Context, slot *indexSlot) error {
	unlock := n.names.lock(slot.name)
	defer unlock()
	current, open := n.slotOf(slot.name)
	if current != slot {
		return indexNotFound(slot.name)
	}
	if open != nil {
		return nil
	}
	if n.manager == nil {
		return narsilerr.New(narsilerr.CodeConfigInvalid, "An index needs durability before it can reopen", map[string]any{})
	}
	durable, err := n.manager.RecoverIndex(ctx, slot.name)
	entry := n.recovering.take(slot.name)
	if err != nil {
		if entry != nil {
			entry.dispose()
		}
		return err
	}
	if entry == nil {
		_ = durable.Close(context.WithoutCancel(ctx))
		return narsilerr.New(narsilerr.CodePersistenceLoadFailed, fmt.Sprintf("Index %q could not be reopened", slot.name),
			map[string]any{"indexName": slot.name})
	}
	entry.durable = durable
	if err := n.indexLoaded(ctx, entry); err != nil {
		_ = durable.Close(context.WithoutCancel(ctx))
		entry.dispose()
		return err
	}
	n.indexesMu.Lock()
	n.indexes[entry.name] = entry
	n.indexesMu.Unlock()
	return nil
}

func (n *Narsil) indexLoaded(ctx context.Context, entry *indexEntry) error {
	n.resumeAnalysisWork(ctx, entry)
	return nil
}
