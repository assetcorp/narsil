package engine

import (
	"context"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

type rebalanceRun struct {
	target   int
	queue    []persist.Write
	states   map[string]bool
	buffered *persist.BufferedLog
	replayed chan struct{}
}

type rebuildLog struct {
	ids     map[string]struct{}
	cleared bool
}

func rebalancingBackpressure(indexName string, message string) error {
	return narsilerr.New(narsilerr.CodePartitionRebalancingBackpressure, message, map[string]any{"indexName": indexName})
}

func queueFull(size int) error {
	return narsilerr.New(narsilerr.CodePartitionRebalancingBackpressure,
		"Write-ahead queue is full ("+strconv.Itoa(maxRebalanceQueueEntries)+" entries). Retry after rebalancing completes.",
		map[string]any{"maxSize": maxRebalanceQueueEntries, "currentSize": size})
}

func (run *rebalanceRun) state(id string) (bool, bool) {
	present, buffered := run.states[id]
	return present, buffered
}

func (run *rebalanceRun) buffer(ctx context.Context, writes []persist.Write) ([]error, error) {
	failures := make([]error, len(writes))
	room := max(0, maxRebalanceQueueEntries-len(run.queue))
	accepted := writes
	if len(writes) > room {
		accepted = writes[:room]
		for at := room; at < len(writes); at++ {
			failures[at] = queueFull(len(run.queue) + room)
		}
	}
	if run.buffered != nil && len(accepted) > 0 {
		if err := run.buffered.Append(ctx, accepted); err != nil {
			return nil, err
		}
	}
	for _, write := range accepted {
		run.queue = append(run.queue, write)
		run.states[write.DocumentID] = write.Document != nil
	}
	return failures, nil
}

func (run *rebalanceRun) take() []persist.Write {
	queued := run.queue
	run.queue = nil
	return queued
}

func (entry *indexEntry) intercept(ctx context.Context, writes []persist.Write) ([]error, bool, error) {
	entry.swap.mu.Lock()
	run := entry.swap.rebalance
	if log := entry.swap.log; log != nil {
		for _, write := range writes {
			log.ids[write.DocumentID] = struct{}{}
		}
	}
	entry.swap.mu.Unlock()
	if run == nil {
		return nil, false, nil
	}
	failures, err := run.buffer(ctx, writes)
	return failures, true, err
}

func (entry *indexEntry) queuedWrites() int {
	if run := entry.rebalancing(); run != nil {
		return len(run.queue)
	}
	return 0
}

func (entry *indexEntry) capacityPartitionCount() int {
	count := entry.index().PartitionCount()
	if run := entry.rebalancing(); run != nil {
		return min(count, run.target)
	}
	return count
}

func (entry *indexEntry) replayInto(ctx context.Context, target *index.Index, writes []persist.Write) error {
	if len(writes) == 0 {
		return nil
	}
	failures, err := entry.handle.ApplyTo(context.WithoutCancel(ctx), target, writes, true)
	for _, path := range entry.vectorPaths {
		entry.handle.Vectors[path].ScheduleBuild()
	}
	if err != nil {
		return err
	}
	for _, failure := range failures {
		if failure != nil && narsilerr.CodeOf(failure) != narsilerr.CodeDocNotFound {
			return failure
		}
	}
	return nil
}

func (entry *indexEntry) awaitReplay(ctx context.Context) error {
	if run := entry.rebalancing(); run != nil {
		select {
		case <-run.replayed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return ctx.Err()
}
