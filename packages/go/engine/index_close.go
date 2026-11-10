package engine

import (
	"context"
	"sort"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

// Open loads the closed index called indexName from its saved checkpoint and
// write-ahead log, so the next call on it runs at once. It also clears a
// failure that an earlier reopen left on the index, so a caller can retry an
// index in the reopen-failed state. Opening an index that is already open
// does nothing. It returns CodeIndexNotFound for an unknown name and the
// recovery code of the load when the saved files cannot be read.
func (n *Narsil) Open(ctx context.Context, indexName string) error {
	leave, err := n.enter()
	if err != nil {
		return err
	}
	defer leave()
	for {
		slot, _ := n.slotOf(indexName)
		if slot == nil {
			return indexNotFound(indexName)
		}
		if err := n.reopen(ctx, slot, true); err != nil {
			return err
		}
		if slot.publicState() == model.IndexOpen {
			if current, open := n.slotOf(indexName); current == slot && open != nil {
				slot.touch()
				n.enforceOpenLimits(ctx, indexName)
				return nil
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	}
}

// Close waits for the reads and writes running on the index called
// indexName, saves a checkpoint of it, and releases its memory while keeping
// its saved files, so ListIndexes reports it as closed. The next call that
// reads or writes the index loads it again. Closing a closed index does
// nothing. It returns CodeIndexNotFound for an unknown name and
// CodeConfigInvalid when the engine has no durability to reopen it from.
func (n *Narsil) Close(ctx context.Context, indexName string) error {
	leave, err := n.enter()
	if err != nil {
		return err
	}
	defer leave()
	unlock := n.names.lock(indexName)
	defer unlock()
	slot, _ := n.slotOf(indexName)
	if slot == nil {
		return indexNotFound(indexName)
	}
	_, err = n.closeSlot(ctx, slot, false)
	return err
}

func (n *Narsil) closeSlot(ctx context.Context, slot *indexSlot, automatic bool) (bool, error) {
	slot.mu.Lock()
	state := slot.state
	slot.mu.Unlock()
	if state == slotClosed || state == slotReopenFailed {
		return true, nil
	}
	if n.manager == nil {
		return false, narsilerr.New(narsilerr.CodeConfigInvalid, "An index needs durability before it can close", map[string]any{})
	}
	_, entry := n.slotOf(slot.name)
	if entry == nil || entry.durable == nil {
		return false, nil
	}
	if automatic {
		if !entry.useMu.TryLock() {
			return false, nil
		}
		if entry.maintenance.Load() > 0 {
			entry.useMu.Unlock()
			return false, nil
		}
	} else {
		entry.useMu.Lock()
	}
	if entry.retired {
		entry.useMu.Unlock()
		return true, nil
	}
	slot.mu.Lock()
	slot.state = slotClosing
	slot.mu.Unlock()
	summary := summaryOf(entry)
	if err := entry.durable.CheckpointFromMemory(ctx); err != nil {
		slot.mu.Lock()
		slot.state = slotOpen
		slot.mu.Unlock()
		entry.useMu.Unlock()
		return false, err
	}
	closeErr := entry.durable.Close(ctx)
	entry.retired = true
	n.uninstall(entry)
	slot.mu.Lock()
	slot.state, slot.summary = slotClosed, summary
	slot.failures, slot.nextReopenAt, slot.cachedErr = 0, time.Time{}, nil
	slot.mu.Unlock()
	entry.useMu.Unlock()
	entry.dispose()
	n.workers.forget(slot.name)
	return true, closeErr
}

func (n *Narsil) openSlots() []*indexSlot {
	n.indexesMu.RLock()
	defer n.indexesMu.RUnlock()
	slots := make([]*indexSlot, 0, len(n.indexes))
	for name := range n.indexes {
		if slot, found := n.slots[name]; found {
			slots = append(slots, slot)
		}
	}
	return slots
}

func (n *Narsil) exceedsOpenLimits() bool {
	lifecycle := n.config.Lifecycle
	open, bytes := 0, int64(0)
	for _, entry := range n.sortedEntries() {
		open++
		bytes += entry.estimatedBytes()
	}
	if limit, set := lifecycle.MaxOpenIndexes.Get(); set && open > limit {
		return true
	}
	limit, set := lifecycle.MaxOpenBytes.Get()
	return set && bytes > limit
}

func (n *Narsil) enforceOpenLimits(ctx context.Context, protected string) {
	lifecycle := n.config.Lifecycle
	if lifecycle == nil || (!lifecycle.MaxOpenIndexes.IsSet() && !lifecycle.MaxOpenBytes.IsSet()) {
		return
	}
	for n.exceedsOpenLimits() {
		candidates := n.openSlots()
		sort.Slice(candidates, func(left, right int) bool {
			return candidates[left].lastAccess.Load() < candidates[right].lastAccess.Load()
		})
		closed := false
		for _, candidate := range candidates {
			if candidate.name == protected {
				continue
			}
			if n.closeAutomatically(ctx, candidate) {
				closed = true
				break
			}
		}
		if !closed {
			return
		}
	}
}

func (n *Narsil) closeAutomatically(ctx context.Context, slot *indexSlot) bool {
	unlock, held := n.names.tryLock(slot.name)
	if !held {
		return false
	}
	defer unlock()
	closed, err := n.closeSlot(ctx, slot, true)
	return err == nil && closed
}

func (n *Narsil) sweepInterval() time.Duration {
	lifecycle := n.config.Lifecycle
	requested := maxSweepInterval
	if timeout, set := lifecycle.IdleTimeout.Get(); set {
		requested = timeout / 2
	}
	return min(maxSweepInterval, max(minSweepInterval, requested))
}

func (n *Narsil) sweepIdle() {
	leave, err := n.enter()
	if err != nil {
		return
	}
	defer leave()
	if timeout, set := n.config.Lifecycle.IdleTimeout.Get(); set && timeout > 0 {
		cutoff := time.Now().Add(-timeout).UnixNano()
		for _, slot := range n.openSlots() {
			if slot.lastAccess.Load() <= cutoff {
				n.closeAutomatically(n.stopping, slot)
			}
		}
	}
	n.enforceOpenLimits(n.stopping, "")
}

func (n *Narsil) startSweeper() {
	if n.config.Lifecycle == nil {
		return
	}
	interval := n.sweepInterval()
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-n.stopping.Done():
				return
			case <-ticker.C:
				n.sweepIdle()
			}
		}
	}()
}
