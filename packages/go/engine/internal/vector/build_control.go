package vector

import (
	"context"
	"time"
)

type buildControl struct {
	running          bool
	idle             chan struct{}
	lifetime         context.Context
	stop             context.CancelFunc
	failure          error
	retry            *time.Timer
	waitingForMemory bool
	rebuilding       bool
}

func (b *buildControl) init() {
	b.idle = make(chan struct{})
	close(b.idle)
	b.lifetime, b.stop = context.WithCancel(context.Background())
}

func (f *Field) claimBuildLocked() {
	f.builds.running = true
	f.builds.idle = make(chan struct{})
}

func (f *Field) releaseBuildLocked(failure error) {
	f.builds.running = false
	f.builds.rebuilding = false
	if failure != nil {
		f.builds.failure = failure
	}
	close(f.builds.idle)
}

func (f *Field) beginExclusiveBuild(ctx context.Context) error {
	for {
		f.writeMu.Lock()
		if f.disposed {
			f.writeMu.Unlock()
			return f.disposedError()
		}
		if !f.builds.running {
			f.claimBuildLocked()
			f.writeMu.Unlock()
			return nil
		}
		idle := f.builds.idle
		f.writeMu.Unlock()
		select {
		case <-idle:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (f *Field) endExclusiveBuild(failure error) {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	f.releaseBuildLocked(nil)
	if failure == nil {
		f.scheduleBuildLocked()
	}
}

func (f *Field) buildDue() bool {
	if f.graph == nil {
		return f.liveSize() >= f.config.promotionThreshold
	}
	return f.buffer.size() > 0 && f.buffer.size() >= f.config.promotionThreshold
}

func (f *Field) ScheduleBuild() {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if f.cold == nil {
		f.scheduleBuildLocked()
	}
}

func (f *Field) nudgeBuild() {
	if !f.writeMu.TryLock() {
		return
	}
	defer f.writeMu.Unlock()
	if f.cold == nil && f.buffer.size() > 0 {
		f.scheduleBuildLocked()
	}
}

func (f *Field) scheduleBuildLocked() {
	if f.builds.running || f.disposed || f.restoring > 0 || !f.buildDue() {
		return
	}
	f.claimBuildLocked()
	go f.runBackgroundBuild()
}

func (f *Field) runBackgroundBuild() {
	ctx := f.builds.lifetime
	err := f.backgroundBuildPass(ctx)
	if err == nil {
		err = f.shuffledRebuildWhenDue(ctx)
	}
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if ctx.Err() != nil {
		f.releaseBuildLocked(nil)
		return
	}
	f.releaseBuildLocked(err)
	if err == nil {
		f.scheduleBuildLocked()
	}
}

func (f *Field) backgroundBuildPass(ctx context.Context) error {
	f.writeMu.Lock()
	graph := f.graph
	snapshot := f.buffer.values()
	f.writeMu.Unlock()
	if graph != nil {
		return f.growGraph(ctx, graph, snapshot)
	}
	return f.promoteToGraph(ctx)
}

func (f *Field) AwaitPendingBuild(ctx context.Context) error {
	if err := f.untilColdLoaded(ctx); err != nil {
		return err
	}
	for {
		f.writeMu.Lock()
		if !f.builds.running {
			failure := f.builds.failure
			f.builds.failure = nil
			f.writeMu.Unlock()
			return failure
		}
		idle := f.builds.idle
		f.writeMu.Unlock()
		select {
		case <-idle:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (f *Field) Building() bool {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	return f.builds.running || f.builds.retry != nil
}
