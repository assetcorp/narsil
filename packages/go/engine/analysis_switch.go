package engine

import (
	"context"
	"errors"
	"reflect"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/synonyms"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

type sideRebuild struct {
	analyzer     *analysis.Analyzer
	proceed      func() error
	adopt        func(rules []model.SynonymRule, settings index.Settings) func()
	committed    func(listed manifest.Manifest) bool
	renewsEpoch  bool
	onPartitions func(rebuilt int)
}

func (entry *indexEntry) adoptSettings(analyzer *analysis.Analyzer, described analysisSettings,
	tokenizer model.TokenizerSetting, stopWords model.StopWords, rules []model.SynonymRule,
	settings index.Settings) func() {
	entry.settingsMu.Lock()
	analyzerBefore, analysisBefore, configBefore := entry.analyzer, entry.analysis, entry.config
	entry.analyzer, entry.analysis = analyzer, described
	entry.config.Language, entry.config.Tokenizer, entry.config.StopWords = described.language, tokenizer, stopWords
	entry.config.Synonyms = rules
	entry.settingsMu.Unlock()
	entry.swap.mu.Lock()
	pendingBefore, staleBefore := entry.swap.pending, entry.swap.stale
	entry.swap.pending, entry.swap.stale = nil, nil
	entry.swap.mu.Unlock()
	baseBefore := entry.swap.base
	entry.swap.base = settings
	return func() {
		entry.settingsMu.Lock()
		entry.analyzer, entry.analysis = analyzerBefore, analysisBefore
		entry.config.Language, entry.config.Tokenizer, entry.config.StopWords =
			configBefore.Language, configBefore.Tokenizer, configBefore.StopWords
		entry.config.Synonyms = configBefore.Synonyms
		entry.settingsMu.Unlock()
		entry.swap.mu.Lock()
		entry.swap.pending, entry.swap.stale = pendingBefore, staleBefore
		entry.swap.mu.Unlock()
		entry.swap.base = baseBefore
	}
}

func (entry *indexEntry) installTerms(ctx context.Context, install func() (persist.IndexSwap, bool, error)) (func(), error) {
	if entry.durable != nil {
		return entry.durable.SwapIndex(ctx, install)
	}
	swap, _, err := install()
	if err != nil {
		return nil, err
	}
	entry.handle.Index = swap.Index
	entry.handle.NewDetachedIndex = swap.NewDetachedIndex
	return nil, nil
}

func (entry *indexEntry) switchTerms(ctx context.Context, built *index.Index, settings index.Settings, side sideRebuild) error {
	for {
		if err := side.proceed(); err != nil {
			return err
		}
		if err := entry.catchUpRound(ctx, built); err != nil {
			return err
		}
		from := entry.currentConfig().Synonyms
		lookup, rules, err := prepareSynonyms(side.analyzer, from, false)
		if err != nil {
			return err
		}
		err = entry.cutover(ctx, built, settings, side, preparedSynonyms{from: from, lookup: lookup, rules: rules})
		var missed *analysis.MissedTokens
		switch {
		case errors.As(err, &missed):
			entry.rememberLogged(missed.Sources)
		case errors.Is(err, analysis.ErrTokensNotKept), errors.Is(err, errSynonymsReplaced):
		default:
			return err
		}
	}
}

type preparedSynonyms struct {
	from   []model.SynonymRule
	lookup *synonyms.Lookup
	rules  []model.SynonymRule
}

var errSynonymsReplaced = errors.New("the synonym sets changed while the analysis switch prepared them")

func (entry *indexEntry) cutover(ctx context.Context, built *index.Index, settings index.Settings, side sideRebuild,
	prepared preparedSynonyms) error {
	entry.lockWrites()
	var finish func()
	defer func() {
		entry.writeMu.Unlock()
		if finish != nil {
			finish()
		}
	}()
	previous := entry.index()
	var err error
	finish, err = entry.installTerms(ctx, func() (persist.IndexSwap, bool, error) {
		if err := side.proceed(); err != nil {
			return persist.IndexSwap{}, false, err
		}
		if !reflect.DeepEqual(entry.currentConfig().Synonyms, prepared.from) {
			return persist.IndexSwap{}, false, errSynonymsReplaced
		}
		if err := entry.cutoverWrites(ctx, built); err != nil {
			return persist.IndexSwap{}, false, err
		}
		lookup, rules := prepared.lookup, prepared.rules
		built.SetSynonyms(lookup)
		built.SetBM25(previous.BM25())
		settings.Synonyms = lookup
		undo := side.adopt(rules, settings)
		entry.swap.current.Store(built)
		return persist.IndexSwap{Index: built, NewDetachedIndex: detachedBuilder(settings, built), Committed: side.committed,
			Revert: func(*index.Index) error {
				entry.swap.current.Store(previous)
				undo()
				return nil
			}}, true, nil
	})
	return err
}

func (n *Narsil) rebuildSide(entry *indexEntry, side sideRebuild) error {
	live := entry.index()
	entry.lockWrites()
	settings := entry.settingsFor(side.analyzer, live.PartitionCount())
	entry.writeMu.Unlock()
	built, err := index.New(settings)
	if err != nil {
		return err
	}
	defer func() { n.retireReplaced(entry, live, built) }()
	if err := entry.beginRebuildLog(built); err != nil {
		return err
	}
	defer entry.endRebuildLog()
	step := func() error {
		if err := side.proceed(); err != nil {
			return err
		}
		return entry.catchUp(n.stopping, built, side.proceed)
	}
	if err := copyDocuments(n.stopping, entry.handle, live, built, step, side.onPartitions,
		copyHoldsBesideWritesOf(entry)); err != nil {
		return err
	}
	if err := built.AwaitCompactionPass(n.stopping); err != nil {
		entry.endRebuildLog()
		go built.Release()
		built = nil
		if stopped := side.proceed(); stopped != nil {
			return stopped
		}
		return err
	}
	if err := entry.catchUp(n.stopping, built, side.proceed); err != nil {
		return err
	}
	if side.renewsEpoch {
		releaseEpoch, err := n.holdRenewedSyncEpoch(n.stopping, entry)
		if err != nil {
			return err
		}
		defer releaseEpoch()
	}
	return entry.switchTerms(n.stopping, built, settings, side)
}

func (n *Narsil) emitRebuild(entry *indexEntry, status model.ProgressStatus, rebuilt int, count int, err error) {
	n.events.emit(model.AnalysisRebuildEvent{IndexName: entry.name, Status: status, PartitionsRebuilt: rebuilt,
		PartitionCount: count, Err: err})
}

func (n *Narsil) buildAndSwitch(entry *indexEntry, run *changeRun, generation uint64) error {
	count := entry.index().PartitionCount()
	rebuilt := 0
	n.emitRebuild(entry, model.ProgressStarted, 0, count, nil)
	target := run.target
	side := sideRebuild{
		analyzer: target.analyzer,
		proceed: func() error {
			if stopped := run.stopReason(); stopped != nil {
				return stopped
			}
			if entry.restoreInFlight() {
				return restoreInFlightError(entry.name)
			}
			return n.proceedFor(n.stopping, entry, "analysis change")()
		},
		adopt: func(rules []model.SynonymRule, settings index.Settings) func() {
			run.markSwitched()
			described := target.described
			described.generation = generation
			return entry.adoptSettings(target.analyzer, described, target.tokenizer, target.stopWords, rules, settings)
		},
		committed:    func(listed manifest.Manifest) bool { return listed.AnalysisGeneration == generation },
		renewsEpoch:  true,
		onPartitions: func(built int) { rebuilt = built },
	}
	if err := n.rebuildSide(entry, side); err != nil {
		n.emitRebuild(entry, model.ProgressFailed, rebuilt, count, err)
		return err
	}
	n.emitRebuild(entry, model.ProgressCompleted, rebuilt, count, nil)
	return nil
}
