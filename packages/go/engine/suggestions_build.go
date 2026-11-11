package engine

import (
	"context"
	"sync"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions"
)

type runningBuild struct {
	build model.QuerySuggestionsBuild
	done  chan struct{}
}

type buildRunner struct {
	runtime *suggestionsRuntime

	mu       sync.Mutex
	running  map[string]*runningBuild
	finished map[string]model.QuerySuggestionsBuild
}

func newBuildRunner(runtime *suggestionsRuntime) *buildRunner {
	return &buildRunner{runtime: runtime, running: map[string]*runningBuild{},
		finished: map[string]model.QuerySuggestionsBuild{}}
}

func publicBuildOf(record suggestions.BuildRecord) model.QuerySuggestionsBuild {
	build := model.QuerySuggestionsBuild{BuildID: record.BuildID,
		Trigger: model.QuerySuggestionsBuildTrigger(record.Trigger), Status: model.QuerySuggestionsBuildPhase(record.Status),
		StartedAt: time.UnixMilli(int64(record.StartedAt)), Published: int(record.Published),
		Removed: int(record.Removed), Discarded: int(record.Discarded), ErrorCode: record.ErrorCode}
	if record.HasEndedAt {
		build.EndedAt = model.Some(time.UnixMilli(int64(record.EndedAt)))
	}
	return build
}

func (runtime *suggestionsRuntime) readBuildRecord(ctx context.Context, indexName string) (
	suggestions.BuildRecord, bool) {
	data, outcome, err := runtime.files.Read(ctx, suggestions.BuildRecordKey(indexName))
	if err != nil || outcome != suggestions.FileRead {
		return suggestions.BuildRecord{}, false
	}
	return suggestions.DecodeBuildRecord(data)
}

func (runtime *suggestionsRuntime) writeBuildRecord(ctx context.Context, indexName string,
	record suggestions.BuildRecord) error {
	data, err := suggestions.EncodeBuildRecord(record)
	if err != nil {
		return err
	}
	return runtime.files.Write(ctx, suggestions.BuildRecordKey(indexName), data)
}

func (runner *buildRunner) lastBuild(ctx context.Context, indexName string) *model.QuerySuggestionsBuild {
	runner.mu.Lock()
	if running, found := runner.running[indexName]; found {
		build := running.build
		runner.mu.Unlock()
		return &build
	}
	if finished, found := runner.finished[indexName]; found {
		runner.mu.Unlock()
		return &finished
	}
	runner.mu.Unlock()
	record, held := runner.runtime.readBuildRecord(ctx, indexName)
	if !held {
		return nil
	}
	build := publicBuildOf(record)
	return &build
}

func (runner *buildRunner) forget(indexName string) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	delete(runner.finished, indexName)
}

func newBuild(trigger model.QuerySuggestionsBuildTrigger, status model.QuerySuggestionsBuildPhase,
	now time.Time) model.QuerySuggestionsBuild {
	return model.QuerySuggestionsBuild{BuildID: suggestions.NewBuildID(), Trigger: trigger, Status: status,
		StartedAt: time.UnixMilli(now.UnixMilli())}
}

func (runner *buildRunner) emitPhase(indexName string, build model.QuerySuggestionsBuild) {
	phase := build.Status
	if phase == model.BuildRunning {
		phase = model.BuildStarted
	}
	runner.runtime.n.events.emit(model.QuerySuggestionsBuildEvent{IndexName: indexName, BuildID: build.BuildID,
		Phase: phase, Trigger: build.Trigger, Published: build.Published, Removed: build.Removed,
		Discarded: build.Discarded, ErrorCode: build.ErrorCode})
}

func (runner *buildRunner) begin(indexName string, trigger model.QuerySuggestionsBuildTrigger) (*runningBuild, error) {
	runtime := runner.runtime
	if _, err := runtime.enabledSetting(indexName); err != nil {
		return nil, err
	}
	if runtime.scrambler == nil {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid,
			"This engine has no query suggestions key, so it builds no suggestions", map[string]any{"indexName": indexName})
	}
	if runtime.stopping() {
		return nil, instanceShutDown()
	}
	leave, err := runtime.n.enter()
	if err != nil {
		return nil, err
	}
	runner.mu.Lock()
	if _, busy := runner.running[indexName]; busy {
		runner.mu.Unlock()
		leave()
		skipped := newBuild(trigger, model.BuildSkipped, runtime.now())
		skipped.EndedAt = model.Some(skipped.StartedAt)
		runner.emitPhase(indexName, skipped)
		done := make(chan struct{})
		close(done)
		return &runningBuild{build: skipped, done: done}, nil
	}
	running := &runningBuild{build: newBuild(trigger, model.BuildRunning, runtime.now()), done: make(chan struct{})}
	runner.running[indexName] = running
	runner.mu.Unlock()
	go func() {
		defer leave()
		runner.run(runtime.n.stopping, indexName, running)
	}()
	return running, nil
}

func (runner *buildRunner) start(ctx context.Context, indexName string, trigger model.QuerySuggestionsBuildTrigger) (
	model.QuerySuggestionsBuild, error) {
	running, err := runner.begin(indexName, trigger)
	if err != nil {
		return model.QuerySuggestionsBuild{}, err
	}
	select {
	case <-running.done:
	case <-ctx.Done():
		return model.QuerySuggestionsBuild{}, ctx.Err()
	}
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return running.build, nil
}

func errorCodeOf(err error) string {
	if held, engineError := narsilerr.As(err); engineError {
		return held.Code
	}
	return narsilerr.CodeWorkerActionFailed
}

func (runner *buildRunner) lastCompleted(ctx context.Context, indexName string) (suggestions.BuildRecord, bool) {
	record, held := runner.runtime.readBuildRecord(ctx, indexName)
	completed := held && (record.Status == string(model.BuildCompleted) || record.Status == string(model.BuildSkipped))
	return record, completed
}

func (runner *buildRunner) run(ctx context.Context, indexName string, running *runningBuild) {
	runtime := runner.runtime
	runner.emitPhase(indexName, running.build)
	started := running.build.StartedAt
	record := suggestions.BuildRecord{BuildID: running.build.BuildID, Trigger: string(running.build.Trigger),
		StartedAt: uint64(started.UnixMilli())}
	last, completed := runner.lastCompleted(ctx, indexName)
	var lastPointer *suggestions.BuildRecord
	if completed {
		lastPointer = &last
	}
	outcome, err := runtime.runBuild(ctx, indexName, lastPointer, started)
	if err != nil {
		record.Status, record.ErrorCode = string(model.BuildFailed), errorCodeOf(err)
	} else {
		record.Status, record.Published, record.Removed = outcome.status, outcome.published, outcome.removed
		record.Discarded, record.SourcesDigest = outcome.discarded, outcome.digest
	}
	record.EndedAt, record.HasEndedAt = uint64(runtime.now().UnixMilli()), true
	saveContext := context.WithoutCancel(ctx)
	if err := runtime.writeBuildRecord(saveContext, indexName, record); err != nil {
		runtime.warn(model.QuerySuggestionsWarningEvent{IndexName: indexName, Reason: model.WarningSaveFailed,
			Message: err.Error()})
	}
	finished := publicBuildOf(record)
	runner.mu.Lock()
	running.build = finished
	runner.finished[indexName] = finished
	if runner.running[indexName] == running {
		delete(runner.running, indexName)
	}
	runner.mu.Unlock()
	runner.emitPhase(indexName, finished)
	close(running.done)
}
