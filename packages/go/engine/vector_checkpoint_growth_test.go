package engine_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	growthDirectoryVariable  = "NARSIL_GROWTH_CHECKPOINT_DIRECTORY"
	growthReadyVariable      = "NARSIL_GROWTH_CHECKPOINT_READY"
	growthIndexName          = "beacons"
	growthPromotionThreshold = 1_000
	growthBaseDocuments      = 1_500
	growthInsertBatch        = 250
	growthRounds             = 12
	growthVectorSeed         = 174_423
	growthStatusPoll         = 100 * time.Microsecond
	growthReadyPoll          = 2 * time.Millisecond
	growthPassTimeout        = 2 * time.Minute
	growthChildTimeout       = 8 * time.Minute
)

func growthID(slot int) string {
	return fmt.Sprintf("beacon-%05d", slot)
}

func growthVector(slot int) []float32 {
	return randomUnitishVector(rand.New(rand.NewSource(int64(growthVectorSeed + slot))))
}

func growthEngine(ctx context.Context, directory string) (*engine.Narsil, error) {
	return engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
			CheckpointMutationThreshold: engine.Some(crashDistantThreshold)}})
}

func growthStatus(narsil *engine.Narsil) (engine.VectorMaintenanceResult, error) {
	statuses, err := narsil.VectorMaintenanceStatus(growthIndexName)
	if err != nil {
		return engine.VectorMaintenanceResult{}, err
	}
	if len(statuses) != 1 {
		return engine.VectorMaintenanceResult{}, fmt.Errorf("the index reports %d vector fields, where it holds one", len(statuses))
	}
	return statuses[0], nil
}

func insertGrowthSlots(ctx context.Context, narsil *engine.Narsil, first int, count int) error {
	batch := make([]*engine.Document, 0, count)
	for slot := first; slot < first+count; slot++ {
		batch = append(batch, engine.DocumentFromMap(map[string]any{"id": growthID(slot), "title": "beacon " + strconv.Itoa(slot),
			"embedding": growthVector(slot)}))
	}
	result, err := narsil.InsertBatch(ctx, growthIndexName, batch, engine.InsertOptions{})
	if err != nil {
		return err
	}
	if len(result.Failed) > 0 {
		return result.Failed[0].Err
	}
	return nil
}

func untilGrowthStatus(narsil *engine.Narsil, reached func(status engine.VectorMaintenanceResult) bool) (engine.VectorMaintenanceResult, error) {
	deadline := time.Now().Add(growthPassTimeout)
	for time.Now().Before(deadline) {
		status, err := growthStatus(narsil)
		if err != nil || reached(status) {
			return status, err
		}
		time.Sleep(growthStatusPoll)
	}
	return engine.VectorMaintenanceResult{}, errors.New("the vector field never reached the awaited build state")
}

func checkpointInsideGrowthPass(ctx context.Context, narsil *engine.Narsil) (bool, error) {
	before, err := untilGrowthStatus(narsil, func(status engine.VectorMaintenanceResult) bool {
		return status.BufferSize < growthPromotionThreshold
	})
	if err != nil || before.BufferSize == 0 {
		return false, err
	}
	if err := narsil.Checkpoint(ctx, growthIndexName); err != nil {
		return false, err
	}
	after, err := growthStatus(narsil)
	return after.BufferSize > 0, err
}

func runGrowthCheckpointChild(directory string, readyPath string) error {
	ctx := context.Background()
	narsil, err := growthEngine(ctx, directory)
	if err != nil {
		return err
	}
	schema := engine.Schema{"title": engine.FieldString, "embedding": engine.VectorFieldType(placingDimension)}
	promotion := &engine.VectorIndexConfig{Threshold: engine.Some(growthPromotionThreshold)}
	if err := narsil.CreateIndex(ctx, growthIndexName, engine.IndexConfig{Schema: schema, VectorPromotion: promotion}); err != nil {
		return err
	}
	for first := 0; first < growthBaseDocuments; first += growthInsertBatch {
		if err := insertGrowthSlots(ctx, narsil, first, growthInsertBatch); err != nil {
			return err
		}
	}
	if err := narsil.OptimizeVectors(ctx, growthIndexName, "embedding"); err != nil {
		return err
	}
	if err := narsil.Checkpoint(ctx, growthIndexName); err != nil {
		return err
	}
	inserted := growthBaseDocuments
	for range growthRounds {
		if err := insertGrowthSlots(ctx, narsil, inserted, growthPromotionThreshold); err != nil {
			return err
		}
		inserted += growthPromotionThreshold
		inside, err := checkpointInsideGrowthPass(ctx, narsil)
		if err != nil {
			return err
		}
		if inside {
			if err := os.WriteFile(readyPath+".partial", []byte(strconv.Itoa(inserted)), 0o644); err != nil {
				return err
			}
			if err := os.Rename(readyPath+".partial", readyPath); err != nil {
				return err
			}
			select {}
		}
		if _, err := untilGrowthStatus(narsil, func(status engine.VectorMaintenanceResult) bool {
			return status.BufferSize == 0 && !status.Building
		}); err != nil {
			return err
		}
	}
	return fmt.Errorf("no checkpoint was taken inside a growth pass in %d passes", growthRounds)
}

func documentsHeldWhenTheChildStopped(t *testing.T, directory string) int {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("finding the test binary failed: %v", err)
	}
	readyPath := t.TempDir() + "/ready"
	child := exec.Command(executable, "-test.run=^$")
	child.Env = append(os.Environ(), growthDirectoryVariable+"="+directory, growthReadyVariable+"="+readyPath)
	var stderr bytes.Buffer
	child.Stderr = &stderr
	if err := child.Start(); err != nil {
		t.Fatalf("starting the child failed: %v", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- child.Wait() }()
	deadline := time.Now().Add(growthChildTimeout)
	for time.Now().Before(deadline) {
		select {
		case err := <-exited:
			t.Fatalf("the child stopped before its checkpoint: %v\n%s", err, stderr.String())
		default:
		}
		if data, err := os.ReadFile(readyPath); err == nil {
			if err := child.Process.Kill(); err != nil {
				t.Fatalf("killing the child failed: %v", err)
			}
			<-exited
			if strings.Contains(stderr.String(), "DATA RACE") {
				t.Fatalf("the race detector reported a race in the child:\n%s", stderr.String())
			}
			inserted, err := strconv.Atoi(string(data))
			if err != nil {
				t.Fatalf("the child reported %q documents: %v", data, err)
			}
			return inserted
		}
		time.Sleep(growthReadyPoll)
	}
	_ = child.Process.Kill()
	t.Fatalf("the child took no checkpoint inside a growth pass:\n%s", stderr.String())
	return 0
}

func requireEveryVectorFindsItself(t *testing.T, label string, narsil *engine.Narsil, live map[string][]float32) {
	t.Helper()
	ctx := context.Background()
	for slot := range len(live) {
		id := growthID(slot)
		query := live[id]
		expected := bruteForceNearest(query, live)
		for _, exact := range []bool{false, true} {
			result, err := narsil.Query(ctx, growthIndexName, placingQuery(query, exact))
			if err != nil {
				t.Fatalf("%s: the search for the vector of %s failed with %s: %v", label, id, codeOrMessage(err), err)
			}
			if len(result.Hits) == 0 || result.Hits[0].ID != expected[0].id {
				t.Fatalf("%s: the search for the vector of %s (exact %v) returned %d hits led by %q, while the brute-force oracle ranks %s first",
					label, id, exact, len(result.Hits), firstHitID(result.Hits), expected[0].id)
			}
			matchesLive := func(hitID string, vector []float32) bool { return sameVector(live[hitID], vector) }
			if err := checkHitsMatchTheirVectors(label, query, result.Hits, matchesLive); err != nil {
				t.Fatal(err)
			}
			if !exact {
				continue
			}
			for position, hit := range result.Hits {
				score, _ := hit.Score.Get()
				if position >= len(expected) || math.Abs(score-expected[position].score) > placingScoreTolerance {
					t.Fatalf("%s: the exact search for the vector of %s ranks %s at %d with score %v, which the brute-force oracle does not hold there",
						label, id, hit.ID, position, score)
				}
			}
		}
	}
}

func firstHitID(hits []engine.Hit) string {
	if len(hits) == 0 {
		return ""
	}
	return hits[0].ID
}

func TestVectorsFindThemselvesAfterAStopFollowingACheckpointTakenWhileTheGraphGrew(t *testing.T) {
	directory := t.TempDir()
	inserted := documentsHeldWhenTheChildStopped(t, directory)
	live := make(map[string][]float32, inserted)
	for slot := range inserted {
		live[growthID(slot)] = growthVector(slot)
	}
	ctx := context.Background()
	narsil, err := growthEngine(ctx, directory)
	if err != nil {
		t.Fatalf("the engine refused the directory after the stop with %s: %v", codeOrMessage(err), err)
	}
	defer func() {
		if err := narsil.Shutdown(ctx); err != nil {
			t.Fatalf("the engine failed to shut down after the restart: %v", err)
		}
	}()
	count, err := narsil.CountDocuments(ctx, growthIndexName)
	if err != nil || count != inserted {
		t.Fatalf("the reopened index counts %d documents (%v), while the child had %d acknowledged", count, err, inserted)
	}
	requireEveryVectorFindsItself(t, "right after the restart", narsil, live)
	loaded, err := untilGrowthStatus(narsil, func(status engine.VectorMaintenanceResult) bool { return !status.LoadingFromFiles })
	if err != nil {
		t.Fatalf("the vector field never finished loading: %v", err)
	}
	if loaded.BufferSize == 0 || loaded.BufferSize >= growthPromotionThreshold || loaded.Building {
		t.Fatalf("the reopened field holds %d vectors outside its graph (building %v), so the checkpoint it loaded was not taken inside a growth pass",
			loaded.BufferSize, loaded.Building)
	}
	requireEveryVectorFindsItself(t, "once the saved graph is loaded", narsil, live)
}
