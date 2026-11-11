package vector

import (
	"context"
	"time"
)

func (f *Field) shuffledRebuildDue(held int) bool {
	if f.graph == nil || held == 0 {
		return false
	}
	if !f.hasShuffledBuild {
		return true
	}
	return f.quantises() && float64(held) >= f.calibration.nextDriftCheckAt
}

func (f *Field) graphNeedsRebuild() bool {
	if f.graph == nil {
		return false
	}
	removed := f.graph.tombstoneCount() + f.compactedNodeCount
	held := f.graph.size() + removed
	if held == 0 {
		return false
	}
	return float64(removed)/float64(held) > rebuildRemovedRatio
}

func (f *Field) admitsRebuild() bool {
	f.writeMu.Lock()
	bytes := 0
	if f.graph != nil {
		bytes = f.graph.bytes()
	}
	admits := f.config.admitsBackgroundBytes
	f.writeMu.Unlock()
	if admits == nil {
		return true
	}
	return admits(int64(bytes))
}

func (f *Field) retryRebuildWhenMemoryAllows() {
	if f.builds.retry != nil || f.disposed {
		return
	}
	f.builds.retry = time.AfterFunc(shuffledRebuildMemoryRetry, func() {
		f.writeMu.Lock()
		f.builds.retry = nil
		if f.disposed || f.builds.running || f.cold != nil {
			f.writeMu.Unlock()
			return
		}
		f.claimBuildLocked()
		f.writeMu.Unlock()
		go f.runShuffledRebuildAlone()
	})
}

func (f *Field) runShuffledRebuildAlone() {
	err := f.shuffledRebuildWhenDue(f.builds.lifetime)
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	f.releaseBuildLocked(err)
	if err == nil {
		f.scheduleBuildLocked()
	}
}

func (f *Field) shuffledRebuildWhenDue(ctx context.Context) error {
	f.writeMu.Lock()
	due := f.shuffledRebuildDue(f.graphSize())
	if !due {
		f.builds.waitingForMemory = false
	}
	f.writeMu.Unlock()
	if !due {
		return nil
	}
	if !f.admitsRebuild() {
		f.writeMu.Lock()
		f.builds.waitingForMemory = true
		f.retryRebuildWhenMemoryAllows()
		f.writeMu.Unlock()
		return nil
	}
	f.writeMu.Lock()
	f.builds.waitingForMemory = false
	f.builds.rebuilding = true
	graph := f.graph
	loadedWithoutCount := !f.hasShuffledBuild
	f.writeMu.Unlock()
	if graph == nil {
		return nil
	}
	recalibrated, err := f.recalibratesForRebuild(ctx, loadedWithoutCount, graph.size())
	if err != nil || !recalibrated {
		return err
	}
	f.writeMu.Lock()
	replaced := f.graph != nil && f.graph.lineage == graph.lineage
	f.writeMu.Unlock()
	if !replaced {
		return nil
	}
	adopted, err := f.buildGraphFromStore(ctx)
	if err == nil && adopted && loadedWithoutCount && f.config.onLoadedGraphRepaired != nil {
		f.config.onLoadedGraphRepaired()
	}
	return err
}

func (f *Field) recalibratesForRebuild(ctx context.Context, loadedWithoutCount bool, held int) (bool, error) {
	if loadedWithoutCount {
		return f.calibrateBeforeBuild(ctx)
	}
	return f.recalibrateWhenDrifted(ctx, held)
}

func (f *Field) graphSize() int {
	if f.graph == nil {
		return 0
	}
	return f.graph.size()
}

func (f *Field) StartShuffledRebuildWhenDue() {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if f.cold != nil || f.disposed || f.builds.running || !f.shuffledRebuildDue(f.graphSize()) {
		return
	}
	f.claimBuildLocked()
	go f.runShuffledRebuildAlone()
}
