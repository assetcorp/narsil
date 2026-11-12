package engine_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	promotingEngines           = 4
	promotingThreshold         = 1_024
	promotingBuildLimit        = 90 * time.Second
	promotingBatchesAfterBuild = 8
)

func graphBuilt(narsil *engine.Narsil, indexName string) (bool, error) {
	statuses, err := narsil.VectorMaintenanceStatus(indexName)
	if err != nil {
		return false, err
	}
	for _, status := range statuses {
		if status.GraphCount == 0 || status.Building {
			return false, nil
		}
	}
	return true, nil
}

func writeThroughPromotion(narsil *engine.Narsil, seed int64) (map[string]any, error) {
	ctx := context.Background()
	random := rand.New(rand.NewSource(seed))
	held := map[string]any{}
	var promotionDue time.Time
	builtAt := -1
	previous := []int{}
	next := 0
	for batch := 0; ; batch++ {
		if builtAt < 0 {
			built, err := graphBuilt(narsil, crashIndexName)
			if err != nil {
				return nil, err
			}
			if built {
				builtAt = batch
			}
		}
		if builtAt >= 0 && batch-builtAt >= promotingBatchesAfterBuild {
			return held, nil
		}
		if builtAt < 0 && next >= promotingThreshold {
			if promotionDue.IsZero() {
				promotionDue = time.Now()
			} else if waited := time.Since(promotionDue); waited > promotingBuildLimit {
				return nil, fmt.Errorf("the vector graph was still unbuilt %s after the field held %d vectors",
					waited.Round(time.Second), promotingThreshold)
			}
		}
		steps := []crashStep{{Op: "insert", Documents: map[string]map[string]any{}}}
		inserted := make([]int, 0, crashInsertBatch)
		for range crashInsertBatch {
			steps[0].Documents[crashSlotID(next)] = crashDocument(random, next)
			inserted = append(inserted, next)
			next++
		}
		for _, slot := range previous {
			id := crashSlotID(slot)
			steps = append(steps, crashStep{Op: "update", ID: id,
				Documents: map[string]map[string]any{id: crashDocument(random, slot)}})
		}
		for _, step := range steps {
			if err := applyCrashStep(ctx, narsil, step); err != nil {
				return nil, err
			}
			applyToOracle(held, step)
		}
		previous = inserted
	}
}

func checkpointUntilStopped(narsil *engine.Narsil, stopped *atomic.Bool) error {
	for !stopped.Load() {
		if err := narsil.Checkpoint(context.Background(), crashIndexName); err != nil {
			return err
		}
		time.Sleep(crashCheckpointPause)
	}
	return nil
}

type promotingRun struct {
	directory string
	held      map[string]any
	archive   bytes.Buffer
	failure   error
}

func promoteWhileCheckpointing(directory string, seed int64) promotingRun {
	ctx := context.Background()
	run := promotingRun{directory: directory}
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: crashDurability(directory, crashModeCheckpoints)})
	if err != nil {
		run.failure = err
		return run
	}
	defer func() {
		if err := narsil.Shutdown(ctx); err != nil && run.failure == nil {
			run.failure = err
		}
	}()
	config := crashIndexConfig(crashModeCheckpoints)
	config.VectorPromotion = &engine.VectorIndexConfig{Threshold: engine.Some(promotingThreshold)}
	if err := narsil.CreateIndex(ctx, crashIndexName, config); err != nil {
		run.failure = err
		return run
	}
	stopped := &atomic.Bool{}
	checkpointed := make(chan error, 1)
	go func() { checkpointed <- checkpointUntilStopped(narsil, stopped) }()
	held, writeErr := writeThroughPromotion(narsil, seed)
	stopped.Store(true)
	if err := errors.Join(writeErr, <-checkpointed); err != nil {
		run.failure = err
		return run
	}
	if err := narsil.Snapshot(ctx, crashIndexName, engine.SnapshotOptions{}, &run.archive); err != nil {
		run.failure = err
		return run
	}
	run.held = held
	return run
}

func restoredDocuments(t *testing.T, archive *bytes.Buffer) map[string]any {
	t.Helper()
	ctx := context.Background()
	narsil := startedInMemory(t)
	if err := narsil.Restore(ctx, crashIndexName, archive); err != nil {
		t.Fatalf("restoring the snapshot failed with %s: %v", codeOrMessage(err), err)
	}
	found, err := exportedDocuments(ctx, narsil, crashIndexName)
	if err != nil {
		t.Fatalf("exporting the restored snapshot failed with %s: %v", codeOrMessage(err), err)
	}
	return found
}

func TestEmbeddingsUpdatedWhileTheVectorFieldPromotesReachSnapshotsAndRestarts(t *testing.T) {
	runs := make([]promotingRun, promotingEngines)
	var group sync.WaitGroup
	for at := range promotingEngines {
		directory := t.TempDir()
		group.Go(func() { runs[at] = promoteWhileCheckpointing(directory, int64(at)) })
	}
	group.Wait()
	for at := range runs {
		run := &runs[at]
		if run.failure != nil {
			t.Fatalf("engine %d failed with %s: %v", at, codeOrMessage(run.failure), run.failure)
		}
		requireAcknowledgedWrites(t, fmt.Sprintf("the snapshot of engine %d", at), run.held,
			restoredDocuments(t, &run.archive), nil)
		requireAcknowledgedWrites(t, fmt.Sprintf("engine %d after a restart", at), run.held,
			reopenedDocuments(t, run.directory, crashModeCheckpoints), nil)
	}
}
