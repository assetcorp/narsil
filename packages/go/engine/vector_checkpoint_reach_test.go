package engine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	reachFeedBatch          = reachPromotionThreshold
	reachFeedLevel          = 8_192
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

func reachID(number int) string {
	return fmt.Sprintf("lantern-%05d", number)
}

func insertReachWave(ctx context.Context, narsil *engine.Narsil, first int, count int) error {
	batch := make([]*engine.Document, 0, count)
	for number := first; number < first+count; number++ {
		batch = append(batch, engine.NewDocument().Set("id", reachID(number)).
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

func reachStatusOf(narsil *engine.Narsil) (engine.VectorMaintenanceResult, error) {
	statuses, err := narsil.VectorMaintenanceStatus(reachIndexName)
	if err != nil {
		return engine.VectorMaintenanceResult{}, err
	}
	if len(statuses) != 1 {
		return engine.VectorMaintenanceResult{}, fmt.Errorf("the index reports %d vector fields, where it holds one", len(statuses))
	}
	return statuses[0], nil
}

func reachStatus(t *testing.T, narsil *engine.Narsil) engine.VectorMaintenanceResult {
	t.Helper()
	status, err := reachStatusOf(narsil)
	if err != nil {
		t.Fatal(err)
	}
	return status
}

func feedReach(ctx context.Context, narsil *engine.Narsil, inserted *atomic.Int64, stop *atomic.Bool) error {
	for !stop.Load() {
		status, err := reachStatusOf(narsil)
		if err != nil {
			return err
		}
		if status.BufferSize >= reachFeedLevel {
			time.Sleep(reachStatusPoll)
			continue
		}
		if err := insertReachWave(ctx, narsil, int(inserted.Load()), reachFeedBatch); err != nil {
			return err
		}
		inserted.Add(reachFeedBatch)
	}
	return nil
}

func untilReachBuilding(narsil *engine.Narsil) error {
	deadline := time.Now().Add(reachSettleTimeout)
	for time.Now().Before(deadline) {
		status, err := reachStatusOf(narsil)
		if err != nil || status.Building {
			return err
		}
		time.Sleep(reachStatusPoll)
	}
	return errors.New("no pass started while vectors arrived")
}

type reachCheckpoint struct {
	acknowledged int
	mayHold      int
	insidePasses bool
	saved        savedGraphCounts
}

func checkpointWhileVectorsArrive(ctx context.Context, narsil *engine.Narsil, node string, directory string,
	inserted *atomic.Int64) (reachCheckpoint, error) {
	var stop atomic.Bool
	fed := make(chan error, 1)
	go func() { fed <- feedReach(ctx, narsil, inserted, &stop) }()
	err := untilReachBuilding(narsil)
	taken := reachCheckpoint{acknowledged: int(inserted.Load())}
	if err == nil {
		err = narsil.Checkpoint(ctx, reachIndexName)
	}
	var after engine.VectorMaintenanceResult
	if err == nil {
		after, err = reachStatusOf(narsil)
	}
	stop.Store(true)
	if err := errors.Join(err, <-fed); err != nil {
		return taken, err
	}
	taken.insidePasses = after.Building
	taken.mayHold = int(inserted.Load())
	taken.saved, err = savedGraphOf(node, directory, reachIndexName)
	return taken, err
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

func nodeForSavedGraphs(t *testing.T) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatalf("node is not on PATH, so nothing outside the engine can read the checkpoint: %v", err)
	}
	return node
}

func savedGraphOf(node string, directory string, indexName string) (savedGraphCounts, error) {
	ctx, cancel := context.WithTimeout(context.Background(), reachReaderDeadline)
	defer cancel()
	command := exec.CommandContext(ctx, node, filepath.Join("testdata", "saved-graph-reach.mjs"), directory, indexName)
	var report, complaint bytes.Buffer
	command.Stdout = &report
	command.Stderr = &complaint
	if err := command.Run(); err != nil {
		return savedGraphCounts{}, fmt.Errorf("the checkpoint reader failed, which needs the dependencies of packages/ts installed: %w\n%s",
			err, complaint.String())
	}
	var fields []savedGraphCounts
	if err := json.Unmarshal(report.Bytes(), &fields); err != nil || len(fields) != 1 {
		return savedGraphCounts{}, fmt.Errorf("the checkpoint reader reported %d fields: %v\n%s", len(fields), err, report.String())
	}
	if fields[0].GraphParts == 0 {
		return savedGraphCounts{}, errors.New("the checkpoint holds no graph")
	}
	return fields[0], nil
}

func readSavedGraph(t *testing.T, node string, directory string, indexName string) savedGraphCounts {
	t.Helper()
	saved, err := savedGraphOf(node, directory, indexName)
	if err != nil {
		t.Fatal(err)
	}
	return saved
}

func savedVectorsOutsideTheirBounds(checkpoint int, saved savedGraphCounts, acknowledged int, mayHold int) string {
	held := saved.LiveNodes + saved.LiveWithoutNode
	if saved.UnreachedLiveNodes > 0 {
		return fmt.Sprintf("checkpoint %d saved a graph of %d nodes that never reaches %d live vectors, such as %v",
			checkpoint, saved.Nodes, saved.UnreachedLiveNodes, saved.UnreachedExamples)
	}
	if held < acknowledged || held > mayHold {
		return fmt.Sprintf("checkpoint %d saved %d live vectors, %d of them without a node, while %d were acknowledged before it began and at most %d could have arrived by its end",
			checkpoint, held, saved.LiveWithoutNode, acknowledged, mayHold)
	}
	return ""
}

func TestCheckpointsTakenWhileVectorsArriveSaveGraphsThatReachEveryVector(t *testing.T) {
	t.Parallel()
	node := nodeForSavedGraphs(t)
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
	if err := insertReachWave(ctx, narsil, 0, reachWaveDocuments); err != nil {
		t.Fatalf("the first wave failed: %v", err)
	}
	waitForReachBuilds(t, narsil)

	var arrived atomic.Int64
	arrived.Store(reachWaveDocuments)
	savedInsideAPass := 0
	for checkpoint := 0; checkpoint < reachCheckpoints; checkpoint++ {
		taken, err := checkpointWhileVectorsArrive(ctx, narsil, node, directory, &arrived)
		if err != nil {
			t.Fatalf("checkpoint %d failed with %s: %v", checkpoint, codeOrMessage(err), err)
		}
		if wrong := savedVectorsOutsideTheirBounds(checkpoint, taken.saved, taken.acknowledged, taken.mayHold); wrong != "" {
			t.Fatal(wrong)
		}
		if taken.insidePasses && taken.saved.LiveWithoutNode > 0 {
			savedInsideAPass++
		}
	}
	if savedInsideAPass == 0 {
		t.Fatal("no checkpoint saved vectors waiting outside the graph while a pass placed them")
	}
	if err := narsil.OptimizeVectors(ctx, reachIndexName, reachFieldName); err != nil {
		t.Fatalf("building the graph of every vector failed: %v", err)
	}
	if err := narsil.Checkpoint(ctx, reachIndexName); err != nil {
		t.Fatalf("the last checkpoint failed: %v", err)
	}
	settled := readSavedGraph(t, node, directory, reachIndexName)
	if settled.LiveNodes != int(arrived.Load()) || settled.LiveWithoutNode != 0 || settled.UnreachedLiveNodes != 0 {
		t.Fatalf("the settled graph holds %d of the %d vectors that arrived, leaves %d without a node, and never reaches %d",
			settled.LiveNodes, arrived.Load(), settled.LiveWithoutNode, settled.UnreachedLiveNodes)
	}
}
