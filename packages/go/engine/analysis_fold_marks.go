package engine

import (
	"context"
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

func foldMarksOfChange(current model.Optional[bool], change model.FoldMarksChange) model.Optional[bool] {
	if change.ResetsToLanguage() {
		return model.Optional[bool]{}
	}
	if on, set := change.Value(); set {
		return model.Some(on)
	}
	return current
}

func (entry *indexEntry) holdsFoldMarksOf(target analysisTarget) bool {
	entry.settingsMu.RLock()
	defer entry.settingsMu.RUnlock()
	return entry.config.FoldMarks == target.foldMarks
}

func (entry *indexEntry) adoptFoldMarks(foldMarks model.Optional[bool], generation uint64) func() {
	built := entry.index()
	entry.settingsMu.Lock()
	configBefore, generationBefore := entry.config.FoldMarks, entry.analysis.generation
	entry.config.FoldMarks, entry.analysis.generation = foldMarks, generation
	entry.settingsMu.Unlock()
	entry.swap.mu.Lock()
	pendingBefore := entry.swap.pending
	entry.swap.pending = nil
	entry.swap.mu.Unlock()
	baseBefore := entry.swap.base.FoldMarks
	entry.swap.base.FoldMarks = foldMarks
	indexBefore := built.FoldMarks()
	built.SetFoldMarks(foldMarks)
	return func() {
		built.SetFoldMarks(indexBefore)
		entry.swap.base.FoldMarks = baseBefore
		entry.swap.mu.Lock()
		entry.swap.pending = pendingBefore
		entry.swap.mu.Unlock()
		entry.settingsMu.Lock()
		entry.config.FoldMarks, entry.analysis.generation = configBefore, generationBefore
		entry.settingsMu.Unlock()
	}
}

func (n *Narsil) committedGeneration(ctx context.Context, entry *indexEntry, generation uint64) bool {
	read, err := checkpoint.ReadManifest(ctx, n.manager.Store(), entry.name)
	return err == nil && read.Kind == checkpoint.ManifestCurrent && read.Manifest.AnalysisGeneration == generation
}

func (n *Narsil) switchFoldMarks(entry *indexEntry, run *changeRun, generation uint64) error {
	if err := n.setPending(entry, run, generation); err != nil {
		return err
	}
	turn, err := n.takeSideBuildTurn()
	if err != nil {
		return err
	}
	defer turn()
	entry.sync.changeMu.Lock()
	defer entry.sync.changeMu.Unlock()
	entry.lockWrites()
	defer entry.writeMu.Unlock()
	if stopped := run.stopReason(); stopped != nil {
		return stopped
	}
	if entry.restoreInFlight() {
		return restoreInFlightError(entry.name)
	}
	if err := n.proceedFor(n.stopping, entry, "analysis change")(); err != nil {
		return err
	}
	run.markSwitched()
	undo := entry.adoptFoldMarks(run.target.foldMarks, generation)
	if entry.durable == nil {
		return nil
	}
	err = entry.durable.Checkpoint(n.stopping)
	if err == nil {
		return nil
	}
	settled := context.WithoutCancel(n.stopping)
	if n.committedGeneration(settled, entry, generation) {
		return entry.durable.PersistMetadata(settled)
	}
	undo()
	return errors.Join(err, entry.durable.PersistMetadata(settled))
}
