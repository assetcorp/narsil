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

	var arriving atomic.Bool
	var arrived atomic.Int64
	arriving.Store(true)
	arrived.Store(reachWaveDocuments)
	waves := make(chan error, 1)
	go func() {
		for arriving.Load() && arrived.Load() < reachMaxDocuments {
			if err := insertReachWave(ctx, narsil, int(arrived.Load()), reachWaveDocuments); err != nil {
				waves <- err
				return
			}
			arrived.Add(reachWaveDocuments)
		}
		waves <- nil
	}()
	savedInsideAPass := 0
	wrong := ""
	for checkpoint := 0; checkpoint < reachCheckpoints && wrong == ""; checkpoint++ {
		acknowledged := int(arrived.Load())
		building := reachStatus(t, narsil).Building
		if err := narsil.Checkpoint(ctx, reachIndexName); err != nil {
			t.Fatalf("checkpoint %d failed with %s: %v", checkpoint, codeOrMessage(err), err)
		}
		stillBuilding := reachStatus(t, narsil).Building
		mayHold := int(arrived.Load()) + reachWaveDocuments
		saved := readSavedGraph(t, node, directory, reachIndexName)
		wrong = savedVectorsOutsideTheirBounds(checkpoint, saved, acknowledged, mayHold)
		if building && stillBuilding && saved.LiveWithoutNode > 0 {
			savedInsideAPass++
		}
	}
	arriving.Store(false)
	if err := <-waves; err != nil {
		t.Fatalf("a wave failed with %s: %v", codeOrMessage(err), err)
	}
	if wrong != "" {
		t.Fatal(wrong)
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
