package engine_test

import (
	"context"
	"fmt"
	"io/fs"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	failedLoadIndex         = "harbours"
	failedLoadField         = "embedding"
	failedLoadDimension     = 16
	failedLoadThreshold     = 64
	failedLoadDocuments     = 400
	failedLoadLateID        = "acknowledged-during-failed-load"
	failedLoadSeed          = 4_242
	failedLoadSettleTimeout = 2 * time.Minute
	failedLoadPoll          = 10 * time.Millisecond
)

var savedGraphPartFile = regexp.MustCompile(`-graph-g\d+-p\d+$`)

func failedLoadVector(seed int64) []float32 {
	random := rand.New(rand.NewSource(seed))
	vector := make([]float32, failedLoadDimension)
	for at := range vector {
		vector[at] = float32(random.Float64()*2 - 1)
	}
	return vector
}

func failedLoadLateVector() []float32 {
	vector := make([]float32, failedLoadDimension)
	for at := range vector {
		vector[at] = 1
	}
	return vector
}

func failedLoadEngine(t *testing.T, directory string) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	return narsil
}

func shutDown(t *testing.T, narsil *engine.Narsil, moment string) {
	t.Helper()
	if err := narsil.Shutdown(context.Background()); err != nil {
		t.Fatalf("%s, the engine failed to shut down with %s: %v", moment, codeOrMessage(err), err)
	}
}

func nearestTo(narsil *engine.Narsil, vector []float32) (string, error) {
	result, err := narsil.Query(context.Background(), failedLoadIndex, engine.QueryParams{Mode: engine.SearchVector,
		Limit: engine.Some(1), Vector: &engine.VectorQueryConfig{Field: failedLoadField, Value: vector}})
	if err != nil || len(result.Hits) == 0 {
		return "", err
	}
	return result.Hits[0].ID, nil
}

func savedGraphParts(t *testing.T, directory string) map[string][]byte {
	t.Helper()
	parts := map[string][]byte{}
	err := filepath.WalkDir(directory, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !savedGraphPartFile.MatchString(entry.Name()) {
			return err
		}
		held, err := os.ReadFile(path)
		parts[path] = held
		return err
	})
	if err != nil {
		t.Fatalf("listing the saved graph parts failed: %v", err)
	}
	if len(parts) == 0 {
		t.Fatal("the checkpoint saved no graph part, so the field never opens from disk")
	}
	return parts
}

func damageGraphParts(t *testing.T, parts map[string][]byte) {
	t.Helper()
	for path, held := range parts {
		damaged := append([]byte{}, held...)
		damaged[len(damaged)/2] ^= 0xff
		if err := os.WriteFile(path, damaged, 0o644); err != nil {
			t.Fatalf("damaging %s failed: %v", path, err)
		}
	}
}

func repairGraphParts(t *testing.T, parts map[string][]byte) {
	t.Helper()
	for path, held := range parts {
		if _, err := os.Stat(path); err != nil {
			continue
		}
		if err := os.WriteFile(path, held, 0o644); err != nil {
			t.Fatalf("repairing %s failed: %v", path, err)
		}
	}
}

func seedFailedLoadIndex(t *testing.T, directory string) {
	t.Helper()
	ctx := context.Background()
	narsil := failedLoadEngine(t, directory)
	config := engine.IndexConfig{Schema: engine.Schema{failedLoadField: engine.VectorFieldType(failedLoadDimension)},
		VectorPromotion: &engine.VectorIndexConfig{Threshold: engine.Some(failedLoadThreshold), Storage: engine.VectorStorageDisk}}
	if err := narsil.CreateIndex(ctx, failedLoadIndex, config); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	batch := make([]*engine.Document, failedLoadDocuments)
	for number := range batch {
		batch[number] = engine.NewDocument().Set("id", fmt.Sprintf("harbour-%04d", number)).
			Set(failedLoadField, failedLoadVector(failedLoadSeed+int64(number)))
	}
	result, err := narsil.InsertBatch(ctx, failedLoadIndex, batch, engine.InsertOptions{})
	if err != nil || len(result.Failed) > 0 {
		t.Fatalf("the engine refused the documents: %v %+v", err, result.Failed)
	}
	if err := narsil.OptimizeVectors(ctx, failedLoadIndex, failedLoadField); err != nil {
		t.Fatalf("building the graph failed with %s: %v", codeOrMessage(err), err)
	}
	if err := narsil.Checkpoint(ctx, failedLoadIndex); err != nil {
		t.Fatalf("the checkpoint failed with %s: %v", codeOrMessage(err), err)
	}
	shutDown(t, narsil, "after the first checkpoint")
}

func requireFailedLoad(t *testing.T, narsil *engine.Narsil) {
	t.Helper()
	deadline := time.Now().Add(failedLoadSettleTimeout)
	for time.Now().Before(deadline) {
		if _, err := nearestTo(narsil, failedLoadVector(failedLoadSeed)); err != nil {
			return
		}
		time.Sleep(failedLoadPoll)
	}
	t.Fatal("the damaged graph part never failed the load of the vector field")
}

func requireLateWrite(t *testing.T, narsil *engine.Narsil, moment string) {
	t.Helper()
	deadline := time.Now().Add(failedLoadSettleTimeout)
	var nearest string
	var err error
	for time.Now().Before(deadline) {
		if nearest, err = nearestTo(narsil, failedLoadLateVector()); err == nil && nearest == failedLoadLateID {
			break
		}
		time.Sleep(failedLoadPoll)
	}
	if nearest != failedLoadLateID {
		t.Fatalf("%s, the nearest vector to the acknowledged write is %q with %s", moment, nearest, codeOrMessage(err))
	}
	if _, found, err := narsil.Get(context.Background(), failedLoadIndex, failedLoadLateID); err != nil || !found {
		t.Fatalf("%s, the acknowledged write reads as found %t with %s", moment, found, codeOrMessage(err))
	}
}

func TestAWriteAcknowledgedDuringAFailedVectorLoadComesBackOnceTheFieldLoads(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	seedFailedLoadIndex(t, directory)
	parts := savedGraphParts(t, directory)
	damageGraphParts(t, parts)

	damaged := failedLoadEngine(t, directory)
	requireFailedLoad(t, damaged)
	late := engine.NewDocument().Set("id", failedLoadLateID).Set(failedLoadField, failedLoadLateVector())
	if _, err := damaged.Insert(ctx, failedLoadIndex, late, "", engine.InsertOptions{}); err != nil {
		t.Fatalf("the engine refused the write during the failed load with %s: %v", codeOrMessage(err), err)
	}
	_ = damaged.Checkpoint(ctx, failedLoadIndex)
	shutDown(t, damaged, "after the failed load")

	repairGraphParts(t, parts)
	repaired := failedLoadEngine(t, directory)
	requireLateWrite(t, repaired, "after the graph part was repaired")
	if err := repaired.Checkpoint(ctx, failedLoadIndex); err != nil {
		t.Fatalf("the checkpoint after the repair failed with %s: %v", codeOrMessage(err), err)
	}
	shutDown(t, repaired, "after the repair")

	reopened := failedLoadEngine(t, directory)
	defer shutDown(t, reopened, "at the end")
	requireLateWrite(t, reopened, "after a checkpoint and another restart")
}
