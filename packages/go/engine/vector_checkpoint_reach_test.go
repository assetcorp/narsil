package engine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	reachIndexName          = "lanterns"
	reachFieldName          = "embedding"
	reachDimension          = 48
	reachPromotionThreshold = 256
	reachGraphM             = 4
	reachClusters           = 24
	reachClusterSpread      = 0.02
	reachWaveDocuments      = 3_000
	reachMaxDocuments       = 60_000
	reachCheckpoints        = 30
	reachCentreSeed         = 90_000_000
	reachStatusPoll         = time.Millisecond
	reachSettleTimeout      = 2 * time.Minute
	reachReaderDeadline     = 2 * time.Minute
)

type savedGraphCounts struct {
	FieldPath          string   `json:"fieldPath"`
	GraphParts         int      `json:"graphParts"`
	Nodes              int      `json:"nodes"`
	LiveNodes          int      `json:"liveNodes"`
	LiveWithoutNode    int      `json:"liveWithoutNode"`
	UnreachedLiveNodes int      `json:"unreachedLiveNodes"`
	UnreachedExamples  []string `json:"unreachedExamples"`
}

func reachComponents(seed int64) []float32 {
	random := rand.New(rand.NewSource(seed))
	components := make([]float32, reachDimension)
	for at := range components {
		components[at] = float32(random.Float64()*2 - 1)
	}
	return components
}

func reachVector(number int) []float32 {
	vector := reachComponents(int64(reachCentreSeed + number%reachClusters))
	for at, offset := range reachComponents(int64(number)) {
		vector[at] += offset * reachClusterSpread
	}
	return vector
}

func insertReachWave(ctx context.Context, narsil *engine.Narsil, first int) error {
	batch := make([]*engine.Document, 0, reachWaveDocuments)
	for number := first; number < first+reachWaveDocuments; number++ {
		batch = append(batch, engine.NewDocument().Set("id", fmt.Sprintf("lantern-%05d", number)).
			Set(reachFieldName, reachVector(number)))
	}
	result, err := narsil.InsertBatch(ctx, reachIndexName, batch, engine.InsertOptions{})
	if err != nil {
		return err
	}
	if len(result.Failed) > 0 {
		return result.Failed[0].Err
	}
	return nil
}

func reachStatus(t *testing.T, narsil *engine.Narsil) engine.VectorMaintenanceResult {
	t.Helper()
	statuses, err := narsil.VectorMaintenanceStatus(reachIndexName)
	if err != nil || len(statuses) != 1 {
		t.Fatalf("the index reports %d vector fields: %v", len(statuses), err)
	}
	return statuses[0]
}

func waitForReachBuilds(t *testing.T, narsil *engine.Narsil) {
	t.Helper()
	deadline := time.Now().Add(reachSettleTimeout)
	for time.Now().Before(deadline) {
		if status := reachStatus(t, narsil); !status.Building && status.BufferSize < reachPromotionThreshold {
			return
		}
		time.Sleep(reachStatusPoll)
	}
	t.Fatal("the vector field never finished placing the vectors that arrived")
}

func readSavedGraph(t *testing.T, node string, directory string) savedGraphCounts {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), reachReaderDeadline)
	defer cancel()
	command := exec.CommandContext(ctx, node, filepath.Join("testdata", "saved-graph-reach.mjs"), directory, reachIndexName)
	var report, complaint bytes.Buffer
	command.Stdout = &report
	command.Stderr = &complaint
	if err := command.Run(); err != nil {
		t.Fatalf("the checkpoint reader failed, which needs the dependencies of packages/ts installed: %v\n%s", err, complaint.String())
	}
	var fields []savedGraphCounts
	if err := json.Unmarshal(report.Bytes(), &fields); err != nil || len(fields) != 1 {
		t.Fatalf("the checkpoint reader reported %d fields: %v\n%s", len(fields), err, report.String())
	}
	if fields[0].GraphParts == 0 {
		t.Fatal("the checkpoint holds no graph")
	}
	return fields[0]
}

func TestCheckpointsTakenWhileVectorsArriveSaveGraphsThatReachEveryVector(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatalf("node is not on PATH, so nothing outside the engine can read the checkpoint: %v", err)
	}
	directory := t.TempDir()
	ctx := context.Background()
	narsil, err := growthEngine(ctx, directory)
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	defer func() {
		if err := narsil.Shutdown(ctx); err != nil {
			t.Fatalf("the engine failed to shut down: %v", err)
		}
	}()
	promotion := &engine.VectorIndexConfig{Threshold: engine.Some(reachPromotionThreshold),
		HNSW: &engine.HNSWConfig{M: engine.Some(reachGraphM)}}
	schema := engine.Schema{reachFieldName: engine.VectorFieldType(reachDimension)}
	if err := narsil.CreateIndex(ctx, reachIndexName, engine.IndexConfig{Schema: schema, VectorPromotion: promotion}); err != nil {
		t.Fatalf("creating the index failed: %v", err)
	}
	if err := insertReachWave(ctx, narsil, 0); err != nil {
		t.Fatalf("the first wave failed: %v", err)
	}
	waitForReachBuilds(t, narsil)

	var arriving atomic.Bool
	var arrived atomic.Int64
	arriving.Store(true)
	arrived.Store(reachWaveDocuments)
	waves := make(chan error, 1)
	go func() {
		for arriving.Load() && arrived.Load() < reachMaxDocuments {
			if err := insertReachWave(ctx, narsil, int(arrived.Load())); err != nil {
				waves <- err
				return
			}
			arrived.Add(reachWaveDocuments)
		}
		waves <- nil
	}()
	begunDuringABuild := 0
	unreached := ""
	for checkpoint := 0; checkpoint < reachCheckpoints && unreached == ""; checkpoint++ {
		if reachStatus(t, narsil).Building {
			begunDuringABuild++
		}
		if err := narsil.Checkpoint(ctx, reachIndexName); err != nil {
			t.Fatalf("checkpoint %d failed with %s: %v", checkpoint, codeOrMessage(err), err)
		}
		if saved := readSavedGraph(t, node, directory); saved.UnreachedLiveNodes > 0 {
			unreached = fmt.Sprintf("checkpoint %d saved a graph of %d nodes that never reaches %d live vectors, such as %v",
				checkpoint, saved.Nodes, saved.UnreachedLiveNodes, saved.UnreachedExamples)
		}
	}
	arriving.Store(false)
	if err := <-waves; err != nil {
		t.Fatalf("a wave failed with %s: %v", codeOrMessage(err), err)
	}
	if unreached != "" {
		t.Fatal(unreached)
	}
	if begunDuringABuild == 0 {
		t.Fatal("no checkpoint began while a build placed vectors")
	}
	if err := narsil.OptimizeVectors(ctx, reachIndexName, reachFieldName); err != nil {
		t.Fatalf("building the graph of every vector failed: %v", err)
	}
	if err := narsil.Checkpoint(ctx, reachIndexName); err != nil {
		t.Fatalf("the last checkpoint failed: %v", err)
	}
	settled := readSavedGraph(t, node, directory)
	if settled.LiveNodes != int(arrived.Load()) || settled.LiveWithoutNode != 0 || settled.UnreachedLiveNodes != 0 {
		t.Fatalf("the settled graph holds %d of the %d vectors that arrived, leaves %d without a node, and never reaches %d",
			settled.LiveNodes, arrived.Load(), settled.LiveWithoutNode, settled.UnreachedLiveNodes)
	}
}
