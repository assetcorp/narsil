package engine

import (
	"context"
	"errors"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type staleRebuild struct {
	abandoned atomic.Bool
	done      chan struct{}
	err       error
}

var errStaleRebuildAbandoned = errors.New("the stale analysis rebuild was abandoned")

func holdsStringList(entry *indexEntry) bool {
	for _, fieldType := range entry.parsed.Flatten() {
		if fieldType == model.FieldStringList {
			return true
		}
	}
	return false
}

func (n *Narsil) requirePhraseReady(entry *indexEntry) error {
	if !entry.analysisIsStale() || !holdsStringList(entry) {
		return nil
	}
	mode := model.AnalysisRebuildAuto
	remedy := "Try the query again once the rebuild finishes"
	if n.config.Analysis.Rebuild == model.AnalysisRebuildManual {
		mode = model.AnalysisRebuildManual
		remedy = "This engine leaves the rebuild to its caller, so somebody has to start it with RebuildAnalysis"
	}
	return narsilerr.New(narsilerr.CodeSearchPhraseNotReady,
		`Index "`+entry.name+`" holds array fields whose terms need a rebuild, so it cannot match a phrase yet. `+remedy,
		map[string]any{"indexName": entry.name, "rebuild": string(mode)})
}

func (entry *indexEntry) noteRecovered(meta metadata.Metadata) {
	current := core.LanguageRevision(entry.analyzer.Language())
	pending := meta.PendingAnalysis
	if pending != nil && entry.analysis.generation == pending.Generation &&
		meta.AnalysisGeneration.Or(0) != pending.Generation {
		entry.analysis.revision = current
		entry.swap.promoted = true
		return
	}
	if pending != nil {
		held := *pending
		entry.swap.pending = &held
	}
	stored, recorded := meta.AnalysisRevision.Get()
	gap, gapSet := meta.ArrayPositionGap.Get()
	staleGap := (!gapSet || gap != arrayPositionGap) && entry.config.TrackPositions.Or(true) && holdsStringList(entry)
	if recorded && stored == current && !staleGap {
		return
	}
	entry.analysis.revision = stored
	entry.swap.stale = &staleTerms{storedRevision: meta.AnalysisRevision, storedGap: meta.ArrayPositionGap,
		staleGap: staleGap}
}

func (entry *indexEntry) takePromotion() bool {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	promoted := entry.swap.promoted
	entry.swap.promoted = false
	return promoted
}

func (n *Narsil) resumeAnalysisWork(ctx context.Context, entry *indexEntry) {
	if entry.takePromotion() && entry.durable != nil {
		if err := entry.durable.PersistMetadata(ctx); err != nil {
			n.events.emit(model.DurabilityErrorEvent{Err: err})
		}
	}
	if entry.pendingAnalysisMetadata() != nil {
		_, _ = n.resumeChange(entry)
		return
	}
	if !entry.analysisIsStale() {
		return
	}
	leave, err := n.enter()
	if err != nil {
		return
	}
	go func() {
		defer leave()
		n.reviewStale(n.stopping, entry)
	}()
}

func (n *Narsil) resumeChange(entry *indexEntry) (*changeRun, error) {
	entry.swap.mu.Lock()
	running, pending := entry.swap.change, entry.swap.pending
	entry.swap.mu.Unlock()
	if running != nil || pending == nil {
		return running, nil
	}
	target, err := n.targetOfPending(entry, *pending)
	if err == nil {
		err = requireRebuildMemory(entry.name, entry.index().EstimateMemoryBytes())
	}
	if err != nil {
		n.emitRebuild(entry, model.ProgressFailed, 0, entry.index().PartitionCount(), err)
		return nil, err
	}
	leave, err := n.enter()
	if err != nil {
		return nil, err
	}
	run := newChangeRun(target)
	entry.swap.mu.Lock()
	if entry.swap.change != nil {
		running = entry.swap.change
		entry.swap.mu.Unlock()
		leave()
		return running, nil
	}
	entry.swap.change = run
	entry.swap.mu.Unlock()
	go n.driveChange(entry, run, nil, pending.Generation, leave)
	return run, nil
}

func (entry *indexEntry) staleInfo() (model.StaleAnalysis, bool) {
	entry.swap.mu.Lock()
	stale := entry.swap.stale
	entry.swap.mu.Unlock()
	if stale == nil {
		return model.StaleAnalysis{}, false
	}
	analyzer := entry.currentAnalyzer()
	return model.StaleAnalysis{IndexName: entry.name, Language: analyzer.LanguageName(),
		StoredRevision: stale.storedRevision, CurrentRevision: core.LanguageRevision(analyzer.Language()),
		DocumentCount: entry.index().Count()}, true
}

func (n *Narsil) reviewStale(ctx context.Context, entry *indexEntry) {
	info, stale := entry.staleInfo()
	if !stale || entry.holdsChangeWork() {
		return
	}
	rebuild := func(ctx context.Context) error { return n.rebuildStale(ctx, entry) }
	if hook := n.config.Analysis.OnStaleAnalysis; hook != nil {
		if err := callStaleHook(ctx, hook, info, rebuild); err != nil {
			n.emitRebuild(entry, model.ProgressFailed, 0, entry.index().PartitionCount(), err)
		}
	}
	if n.config.Analysis.Rebuild != model.AnalysisRebuildManual {
		_ = rebuild(ctx)
	}
}

func callStaleHook(ctx context.Context, hook func(context.Context, model.StaleAnalysis, func(context.Context) error) error,
	info model.StaleAnalysis, rebuild func(context.Context) error) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = errors.New("the onStaleAnalysis callback panicked")
		}
	}()
	return hook(ctx, info, rebuild)
}

func (entry *indexEntry) abandonStaleRebuild() {
	entry.swap.mu.Lock()
	run := entry.swap.rebuild
	entry.swap.mu.Unlock()
	if run != nil {
		run.abandoned.Store(true)
	}
}

func (entry *indexEntry) startStaleRebuild() (*staleRebuild, bool, error) {
	entry.swap.mu.Lock()
	defer entry.swap.mu.Unlock()
	if entry.swap.stale == nil {
		return nil, false, nil
	}
	if entry.swap.rebalance != nil {
		return nil, false, rebalancingBackpressure(entry.name,
			`Index "`+entry.name+`" is being rebalanced, so try its analysis rebuild again once the rebalance ends`)
	}
	if run := entry.swap.rebuild; run != nil && !run.abandoned.Load() {
		return run, false, nil
	}
	run := &staleRebuild{done: make(chan struct{})}
	entry.swap.rebuild = run
	return run, true, nil
}

func (n *Narsil) rebuildStale(ctx context.Context, entry *indexEntry) error {
	run, started, err := entry.startStaleRebuild()
	if err != nil || run == nil {
		return err
	}
	if started {
		leave, err := n.enter()
		if err != nil {
			entry.finishStaleRebuild(run, err)
			return err
		}
		go func() {
			defer leave()
			entry.finishStaleRebuild(run, n.runStaleRebuild(entry, run))
		}()
	}
	select {
	case <-run.done:
		return run.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (entry *indexEntry) finishStaleRebuild(run *staleRebuild, err error) {
	entry.swap.mu.Lock()
	if entry.swap.rebuild == run {
		entry.swap.rebuild = nil
	}
	entry.swap.mu.Unlock()
	run.err = err
	close(run.done)
}

func (n *Narsil) runStaleRebuild(entry *indexEntry, run *staleRebuild) error {
	turn, err := n.takeSideBuildTurn()
	if err != nil {
		return err
	}
	defer turn()
	if run.abandoned.Load() || !entry.analysisIsStale() {
		return nil
	}
	entry.maintenance.Add(1)
	defer entry.maintenance.Add(-1)
	count := entry.index().PartitionCount()
	rebuilt := 0
	n.emitRebuild(entry, model.ProgressStarted, 0, count, nil)
	analyzer := entry.currentAnalyzer()
	described := entry.currentAnalysis()
	described.revision = core.LanguageRevision(analyzer.Language())
	config := entry.currentConfig()
	side := sideRebuild{
		analyzer: analyzer,
		proceed: func() error {
			if run.abandoned.Load() {
				return errStaleRebuildAbandoned
			}
			return n.proceedFor(n.stopping, entry, "analysis rebuild")()
		},
		adopt: func(rules []model.SynonymRule, settings index.Settings) func() {
			return entry.adoptSettings(analyzer, described, config.Tokenizer, config.StopWords, rules, settings)
		},
		committed:    func(manifest.Manifest) bool { return false },
		onPartitions: func(built int) { rebuilt = built },
	}
	err = n.rebuildSide(entry, side)
	if errors.Is(err, errStaleRebuildAbandoned) {
		return nil
	}
	if err != nil && n.stopping.Err() != nil && errors.Is(err, context.Canceled) {
		err = engineShutDown()
	}
	if err != nil {
		n.emitRebuild(entry, model.ProgressFailed, rebuilt, count, err)
		return err
	}
	n.emitRebuild(entry, model.ProgressCompleted, rebuilt, count, nil)
	return nil
}

// RebuildAnalysis rebuilds the terms of the index called indexName and
// returns once they answer queries. For an index whose terms an earlier
// analysis revision produced, the engine rebuilds them under the current
// settings and records the current revision. For an index whose analysis
// change a restart interrupted, the engine runs that change again. An index
// with current terms and no pending change returns at once.
func (n *Narsil) RebuildAnalysis(ctx context.Context, indexName string) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	defer n.emitWrite(indexName)
	if entry.pendingAnalysisMetadata() != nil {
		run, err := n.resumeChange(entry)
		if run == nil {
			return err
		}
		return run.wait(ctx)
	}
	return n.rebuildStale(ctx, entry)
}
