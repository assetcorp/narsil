package engine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	crossSettleDeadline = 5 * time.Minute
	crossSettlePoll     = 20 * time.Millisecond
	crossInsertBatch    = 500
	crossScoreTolerance = 1e-12
)

type openedArtifact struct {
	Answers   [][][2]any       `json:"answers"`
	Documents []map[string]any `json:"documents"`
}

type openedArtifacts map[string]openedArtifact

func settleVectors(ctx context.Context, narsil *engine.Narsil, indexName string) error {
	deadline := time.Now().Add(crossSettleDeadline)
	for {
		statuses, err := narsil.VectorMaintenanceStatus(indexName)
		if err != nil {
			return err
		}
		building := false
		for _, status := range statuses {
			building = building || status.Building
		}
		if !building {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s was still building a graph at the deadline", indexName)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(crossSettlePoll):
		}
	}
}

func durableAt(ctx context.Context, directory string) (*engine.Narsil, error) {
	return engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}})
}

func writeFileFrom(t *testing.T, path string, produce func(*bytes.Buffer) error) {
	t.Helper()
	var buffer bytes.Buffer
	if err := produce(&buffer); err != nil {
		t.Fatalf("producing %s failed with %s: %v", filepath.Base(path), codeOrMessage(err), err)
	}
	if err := os.WriteFile(path, buffer.Bytes(), 0o644); err != nil {
		t.Fatalf("writing %s failed: %v", path, err)
	}
}

func goSave(t *testing.T, scenario crossScenario, plan crossPlan, directory string) {
	t.Helper()
	ctx := context.Background()
	narsil, err := durableAt(ctx, filepath.Join(directory, "durable"))
	if err != nil {
		t.Fatalf("the Go engine refused to open its directory: %v", err)
	}
	defer func() { _ = narsil.Shutdown(ctx) }()
	if err := narsil.CreateIndex(ctx, plan.Index, scenario.goConfig()); err != nil {
		t.Fatalf("the Go engine refused the index: %v", err)
	}
	for start := 0; start < len(plan.Documents); start += crossInsertBatch {
		batch := make([]*engine.Document, 0, crossInsertBatch)
		for _, document := range plan.Documents[start:min(start+crossInsertBatch, len(plan.Documents))] {
			batch = append(batch, engine.DocumentFromMap(document))
		}
		result, err := narsil.InsertBatch(ctx, plan.Index, batch, engine.InsertOptions{})
		if err != nil || len(result.Failed) > 0 {
			t.Fatalf("the Go engine refused documents: %v %+v", err, result.Failed)
		}
	}
	if err := settleVectors(ctx, narsil, plan.Index); err != nil {
		t.Fatal(err)
	}
	if stats, err := narsil.GetStats(plan.Index); err != nil || (scenario.partitioned && stats.PartitionCount < 2) {
		t.Fatalf("the Go index holds %d partitions after its inserts: %v", stats.PartitionCount, err)
	}
	if err := narsil.Checkpoint(ctx, plan.Index); err != nil {
		t.Fatalf("the Go checkpoint failed: %v", err)
	}
	writeFileFrom(t, filepath.Join(directory, "snapshot.nrsl"), func(buffer *bytes.Buffer) error {
		return narsil.Snapshot(ctx, plan.Index, engine.SnapshotOptions{}, buffer)
	})
	writeFileFrom(t, filepath.Join(directory, "export.jsonl"), func(buffer *bytes.Buffer) error {
		return narsil.ExportDocuments(ctx, plan.Index, buffer)
	})
	for _, operation := range plan.Later {
		switch operation.Op {
		case "insert":
			_, err = narsil.Insert(ctx, plan.Index, engine.DocumentFromMap(operation.Document), "", engine.InsertOptions{})
		case "update":
			err = narsil.Update(ctx, plan.Index, operation.ID, engine.DocumentFromMap(operation.Document), engine.WriteOptions{})
		case "remove":
			err = narsil.Remove(ctx, plan.Index, operation.ID, engine.WriteOptions{})
		}
		if err != nil {
			t.Fatalf("the Go engine refused to %s %s: %v", operation.Op, operation.ID, err)
		}
	}
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("the Go engine failed to shut down: %v", err)
	}
}

func goOpened(t *testing.T, narsil *engine.Narsil, plan crossPlan) openedArtifact {
	t.Helper()
	ctx := context.Background()
	defer func() { _ = narsil.Shutdown(ctx) }()
	if err := settleVectors(ctx, narsil, plan.Index); err != nil {
		t.Fatal(err)
	}
	opened := openedArtifact{}
	for _, query := range plan.Queries {
		result, err := narsil.Query(ctx, plan.Index, query.goParams())
		if err != nil {
			t.Fatalf("the Go engine failed a query with %s: %v", codeOrMessage(err), err)
		}
		hits := make([][2]any, 0, len(result.Hits))
		for _, hit := range result.Hits {
			score, _ := hit.Score.Get()
			hits = append(hits, [2]any{hit.ID, score})
		}
		opened.Answers = append(opened.Answers, hits)
	}
	documents, err := exportedDocuments(ctx, narsil, plan.Index)
	if err != nil {
		t.Fatalf("the Go engine failed to export: %v", err)
	}
	for id, document := range documents {
		fields, _ := document.(map[string]any)
		fields["id"] = id
		opened.Documents = append(opened.Documents, fields)
	}
	return opened
}

func goOpen(t *testing.T, plan crossPlan, directory string) openedArtifacts {
	t.Helper()
	ctx := context.Background()
	opened := openedArtifacts{}
	narsil, err := durableAt(ctx, filepath.Join(directory, "durable"))
	if err != nil {
		t.Fatalf("the Go engine refused the saved directory with %s: %v", codeOrMessage(err), err)
	}
	opened["durable"] = goOpened(t, narsil, plan)
	for kind, load := range map[string]func(*engine.Narsil, []byte) error{
		"snapshot": func(narsil *engine.Narsil, data []byte) error {
			return narsil.Restore(ctx, plan.Index, bytes.NewReader(data))
		},
		"export": func(narsil *engine.Narsil, data []byte) error {
			result, err := narsil.ImportDocumentExport(ctx, plan.Index, bytes.NewReader(data))
			if err == nil && result.RefusedCount > 0 {
				return fmt.Errorf("the import refused %+v", result.Refused)
			}
			return err
		},
	} {
		file := map[string]string{"snapshot": "snapshot.nrsl", "export": "export.jsonl"}[kind]
		data, err := os.ReadFile(filepath.Join(directory, file))
		if err != nil {
			t.Fatalf("reading the saved %s failed: %v", kind, err)
		}
		narsil, err := durableAt(ctx, t.TempDir())
		if err != nil {
			t.Fatalf("the Go engine refused to start: %v", err)
		}
		if err := load(narsil, data); err != nil {
			t.Fatalf("the Go engine refused the saved %s with %s: %v", kind, codeOrMessage(err), err)
		}
		opened[kind] = goOpened(t, narsil, plan)
	}
	return opened
}

func typeScriptOpen(t *testing.T, planPath string, directory string) openedArtifacts {
	t.Helper()
	output := filepath.Join(t.TempDir(), "opened.json")
	runTypeScriptEngine(t, map[string]any{"mode": "open", "plan": planPath, "directory": directory, "output": output, "scratch": t.TempDir()})
	opened := openedArtifacts{}
	readJSONFile(t, output, &opened)
	return opened
}

func requireOracleDocuments(t *testing.T, label string, documents []map[string]any, oracle map[string]crossDocument) {
	t.Helper()
	if len(documents) != len(oracle) {
		t.Fatalf("%s holds %d documents, while the oracle holds %d", label, len(documents), len(oracle))
	}
	for _, document := range documents {
		id, _ := document["id"].(string)
		want, held := oracle[id]
		if !held {
			t.Fatalf("%s holds %s, which the oracle does not", label, id)
		}
		embedding, _ := document["embedding"].([]any)
		if document["title"] != want.Title || document["summary"] != want.Summary || len(embedding) != len(want.Embedding) || len(document) != 4 {
			t.Fatalf("%s holds %s as %s, not as the oracle's document", label, id, describeJSON(document))
		}
		for component, value := range embedding {
			number, isNumber := value.(float64)
			if !isNumber || float32(number) != want.Embedding[component] {
				t.Fatalf("%s holds component %d of %s as %v, not %v", label, component, id, value, want.Embedding[component])
			}
		}
	}
}

func requireSameAnswers(t *testing.T, label string, left [][][2]any, right [][][2]any, queries []crossQuery, textOnly bool) {
	t.Helper()
	if len(left) != len(queries) || len(right) != len(queries) {
		t.Fatalf("%s answered %d and %d of %d queries", label, len(left), len(right), len(queries))
	}
	for position, query := range queries {
		if textOnly && query.Mode == "vector" {
			continue
		}
		if !sameHits(left[position], right[position]) {
			leftJSON, _ := json.Marshal(left[position])
			rightJSON, _ := json.Marshal(right[position])
			t.Fatalf("%s differ on query %d (%q):\n  %s\n  %s", label, position, query.Term, leftJSON, rightJSON)
		}
	}
}

func sameHits(left [][2]any, right [][2]any) bool {
	if len(left) != len(right) {
		return false
	}
	for rank := range left {
		leftScore, leftScored := left[rank][1].(float64)
		rightScore, rightScored := right[rank][1].(float64)
		if left[rank][0] != right[rank][0] || !leftScored || !rightScored ||
			math.Abs(leftScore-rightScore) > crossScoreTolerance*math.Max(1, math.Abs(rightScore)) {
			return false
		}
	}
	return true
}

func TestCrossImplementationSavesOpenWithTheSameAnswers(t *testing.T) {
	t.Parallel()
	requireTypeScriptEngine(t)
	dataset := loadConformanceDataset(t, fetchPinnedDataset(t))
	if len(dataset.documents) < crossDocumentCount+crossInsertedLater {
		t.Fatal("the dataset holds too few documents for the cross-implementation plan")
	}
	for _, scenario := range crossScenarios() {
		t.Run(scenario.name, func(t *testing.T) {
			t.Parallel()
			plan := buildCrossPlan(dataset, scenario)
			planPath := filepath.Join(t.TempDir(), "plan.json")
			writeJSONFile(t, planPath, plan)
			savedByGo, savedByTypeScript := t.TempDir(), t.TempDir()
			goSave(t, scenario, plan, savedByGo)
			runTypeScriptEngine(t, map[string]any{"mode": "save", "plan": planPath, "directory": savedByTypeScript})
			opened := map[string]openedArtifacts{
				"Go opening Go's save":                 goOpen(t, plan, savedByGo),
				"TypeScript opening Go's save":         typeScriptOpen(t, planPath, savedByGo),
				"Go opening TypeScript's save":         goOpen(t, plan, savedByTypeScript),
				"TypeScript opening TypeScript's save": typeScriptOpen(t, planPath, savedByTypeScript),
			}
			for _, kind := range []string{"durable", "snapshot", "export"} {
				oracle := plan.saved
				if kind == "durable" {
					oracle = plan.final
				}
				for label, artifacts := range opened {
					requireOracleDocuments(t, label+" "+kind, artifacts[kind].Documents, oracle)
				}
				graphFromFile := kind != "export"
				requireSameAnswers(t, "Go's "+kind+" opened by each engine", opened["Go opening Go's save"][kind].Answers,
					opened["TypeScript opening Go's save"][kind].Answers, plan.Queries, !graphFromFile)
				requireSameAnswers(t, "TypeScript's "+kind+" opened by each engine", opened["TypeScript opening TypeScript's save"][kind].Answers,
					opened["Go opening TypeScript's save"][kind].Answers, plan.Queries, !graphFromFile)
				requireSameAnswers(t, "the text answers over each engine's "+kind, opened["Go opening Go's save"][kind].Answers,
					opened["Go opening TypeScript's save"][kind].Answers, plan.Queries, true)
			}
		})
	}
}
