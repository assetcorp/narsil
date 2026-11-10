package engine

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type changeRun struct {
	target   analysisTarget
	mu       sync.Mutex
	stopped  error
	switched bool
	result   error
	once     sync.Once
	finished chan struct{}
	settled  chan struct{}
}

func newChangeRun(target analysisTarget) *changeRun {
	return &changeRun{target: target, finished: make(chan struct{}), settled: make(chan struct{})}
}

func (run *changeRun) end(err error) {
	run.once.Do(func() {
		run.mu.Lock()
		run.result = err
		run.mu.Unlock()
		close(run.finished)
	})
}

func (run *changeRun) stop(indexName string) {
	run.mu.Lock()
	if run.switched || run.stopped != nil {
		run.mu.Unlock()
		return
	}
	run.stopped = narsilerr.New(narsilerr.CodeAnalysisChangeReplaced,
		`A later change or a restore replaced this analysis change of index "`+indexName+`"`,
		map[string]any{"indexName": indexName})
	stopped := run.stopped
	run.mu.Unlock()
	run.end(stopped)
}

func (run *changeRun) stopReason() error {
	run.mu.Lock()
	defer run.mu.Unlock()
	return run.stopped
}

func (run *changeRun) markSwitched() {
	run.mu.Lock()
	run.switched = true
	run.mu.Unlock()
}

func (run *changeRun) wait(ctx context.Context) error {
	select {
	case <-run.finished:
		run.mu.Lock()
		defer run.mu.Unlock()
		return run.result
	case <-ctx.Done():
		return ctx.Err()
	}
}

func restoreInFlightError(indexName string) error {
	return narsilerr.New(narsilerr.CodeAnalysisChangeReplaced,
		`A restore of index "`+indexName+`" is in flight and replaces this analysis change, so try the change again once the restore ends`,
		map[string]any{"indexName": indexName})
}

func (entry *indexEntry) refuseChangeStart() error {
	if entry.rebalancing() != nil {
		return rebalancingBackpressure(entry.name,
			`Index "`+entry.name+`" is being rebalanced, so try its analysis change again once the rebalance ends`)
	}
	if entry.restoreInFlight() {
		return restoreInFlightError(entry.name)
	}
	return nil
}

func megabytesOf(bytes int64) int64 {
	return (bytes + (1 << 20) - 1) >> 20
}

func requireRebuildMemory(indexName string, termBytes int64) error {
	limit, bounded := heapLimit()
	if !bounded || termBytes <= limit-heapUsed() {
		return nil
	}
	runtime.GC()
	available := limit - heapUsed()
	if termBytes <= available {
		return nil
	}
	return narsilerr.New(narsilerr.CodeAnalysisRebuildMemoryExceeded,
		fmt.Sprintf(`The analysis change of index "%s" needs about %d MB of Go heap for a second copy of its terms, and this process has %d MB free, so the index keeps its current settings. Give the process more memory, then change the settings again`,
			indexName, megabytesOf(termBytes), megabytesOf(max(0, available))),
		map[string]any{"indexName": indexName, "budget": "heap", "neededBytes": termBytes, "availableBytes": available})
}

// ChangeAnalysis changes the language, the tokeniser, or the stop words of
// the index called indexName and returns once queries answer under the new
// settings. The engine builds the new terms beside the old ones, so queries
// and writes keep working under the old settings until one switch replaces
// them. A change to the settings that the index already holds returns at
// once. The call returns CodeLanguageNotSupported for an unknown language,
// CodeConfigInvalid for an unregistered name or for a synonym that the new
// settings break, CodeAnalysisRebuildMemoryExceeded when a second copy of the
// terms does not fit the memory limit, CodePartitionRebalancingBackpressure
// while the index rebalances, and CodeAnalysisChangeReplaced when a later
// change or a restore replaces this one. When ctx ends first, the call
// returns the context error and the change continues.
func (n *Narsil) ChangeAnalysis(ctx context.Context, indexName string, change AnalysisChange) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	defer n.emitWrite(indexName)
	if err := entry.refuseChangeStart(); err != nil {
		return err
	}
	target, err := n.targetOfChange(entry, change)
	if err != nil {
		return err
	}
	held := entry.heldBy(target)
	run, err := n.startChange(entry, target, held)
	if err != nil || run == nil {
		return err
	}
	return run.wait(ctx)
}

func (n *Narsil) startChange(entry *indexEntry, target analysisTarget, held bool) (*changeRun, error) {
	entry.swap.mu.Lock()
	previous := entry.swap.change
	entry.swap.mu.Unlock()
	if previous != nil && previous.target.sameAs(target) {
		return previous, nil
	}
	if previous == nil && held {
		return nil, nil
	}
	if !held {
		if err := entry.requireSynonymsUnder(target); err != nil {
			return nil, err
		}
		termBytes, err := entry.index().EstimateMemoryBytes()
		if err != nil {
			return nil, err
		}
		if err := requireRebuildMemory(entry.name, termBytes); err != nil {
			return nil, err
		}
	}
	leave, err := n.enter()
	if err != nil {
		return nil, err
	}
	run := newChangeRun(target)
	entry.swap.mu.Lock()
	if entry.swap.rebalance != nil {
		entry.swap.mu.Unlock()
		leave()
		return nil, rebalancingBackpressure(entry.name,
			`Index "`+entry.name+`" is being rebalanced, so try its analysis change again once the rebalance ends`)
	}
	previous = entry.swap.change
	entry.swap.change = run
	entry.swap.mu.Unlock()
	if previous != nil {
		previous.stop(entry.name)
	}
	go n.driveChange(entry, run, previous, 0, leave)
	return run, nil
}

func (entry *indexEntry) ownsChange(run *changeRun) bool {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	return entry.swap.change == run
}

func (n *Narsil) setPending(entry *indexEntry, run *changeRun, generation uint64) error {
	entry.swap.mu.Lock()
	unchanged := entry.swap.pending != nil && entry.swap.pending.Generation == generation
	if !unchanged {
		entry.swap.pending = run.target.pendingAt(generation)
	}
	entry.swap.mu.Unlock()
	if unchanged || entry.durable == nil {
		return nil
	}
	return entry.durable.PersistMetadata(n.stopping)
}

func (n *Narsil) clearPending(ctx context.Context, entry *indexEntry) error {
	entry.swap.mu.Lock()
	held := entry.swap.pending != nil
	entry.swap.pending = nil
	entry.swap.mu.Unlock()
	if !held || entry.durable == nil {
		return nil
	}
	return entry.durable.PersistMetadata(ctx)
}

func (n *Narsil) nextGeneration(entry *indexEntry) uint64 {
	current := entry.currentAnalysis().generation
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	if entry.swap.pending != nil {
		current = max(current, entry.swap.pending.Generation)
	}
	return current + 1
}

func (n *Narsil) runChange(entry *indexEntry, run *changeRun, previous *changeRun, resumed uint64) error {
	if previous != nil {
		<-previous.settled
	}
	if stopped := run.stopReason(); stopped != nil || !entry.ownsChange(run) {
		return stopped
	}
	if err := n.proceedFor(n.stopping, entry, "analysis change")(); err != nil {
		return err
	}
	if err := entry.refuseChangeStart(); err != nil {
		return err
	}
	if resumed == 0 && entry.heldBy(run.target) {
		return n.clearPending(n.stopping, entry)
	}
	generation := resumed
	if generation == 0 {
		generation = n.nextGeneration(entry)
	}
	if err := n.setPending(entry, run, generation); err != nil {
		return err
	}
	if stopped := run.stopReason(); stopped != nil {
		return stopped
	}
	turn, err := n.takeSideBuildTurn()
	if err != nil {
		return err
	}
	defer turn()
	entry.abandonStaleRebuild()
	return n.buildAndSwitch(entry, run, generation)
}

func (n *Narsil) driveChange(entry *indexEntry, run *changeRun, previous *changeRun, resumed uint64, leave func()) {
	defer leave()
	defer close(run.settled)
	entry.maintenance.Add(1)
	defer entry.maintenance.Add(-1)
	err := n.runChange(entry, run, previous, resumed)
	if err != nil && n.stopping.Err() != nil && errors.Is(err, context.Canceled) {
		err = engineShutDown()
	}
	if err != nil {
		refusedByRestore := run.stopReason() == nil && narsilerr.CodeOf(err) == narsilerr.CodeAnalysisChangeReplaced
		keepsPending := !refusedByRestore && (resumed != 0 || n.stopping.Err() != nil)
		if !keepsPending && run.stopReason() == nil && entry.ownsChange(run) {
			_ = n.clearPending(context.WithoutCancel(n.stopping), entry)
		}
	}
	run.end(err)
	entry.swap.mu.Lock()
	if entry.swap.change == run {
		entry.swap.change = nil
	}
	entry.swap.mu.Unlock()
}
