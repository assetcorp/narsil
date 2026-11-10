package engine_test

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	searchesIndexName        = "bills"
	searchesInsertBatch      = 500
	searchesGraphDeadline    = 10 * time.Minute
	searchesGraphPoll        = 50 * time.Millisecond
	searchesScoreTolerance   = 1e-9
	searchesSimilarityMargin = 1e-6
)

type expectedSearches struct {
	Dataset datasetPin `json:"dataset"`
	Index   struct {
		Schema   map[string]string `json:"schema"`
		Language string            `json:"language"`
	} `json:"index"`
	Text struct {
		Limit   int `json:"limit"`
		Queries []struct {
			ID   string `json:"id"`
			Text string `json:"text"`
			Hits []struct {
				ID    string  `json:"id"`
				Score float64 `json:"score"`
			} `json:"hits"`
		} `json:"queries"`
	} `json:"text"`
	Vector struct {
		Field  string `json:"field"`
		Floors []struct {
			K     int     `json:"k"`
			Floor float64 `json:"floor"`
		} `json:"floors"`
		Queries []struct {
			ID         string `json:"id"`
			Neighbours []struct {
				ID         string  `json:"id"`
				Similarity float64 `json:"similarity"`
			} `json:"neighbours"`
		} `json:"queries"`
	} `json:"vector"`
}

func openBillsIndex(t *testing.T, ctx context.Context, expected expectedSearches, dataset conformanceDataset) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	schema := engine.Schema{}
	for field, fieldType := range expected.Index.Schema {
		schema[field] = engine.FieldType(fieldType)
	}
	if err := narsil.CreateIndex(ctx, searchesIndexName, engine.IndexConfig{Schema: schema, Language: expected.Index.Language}); err != nil {
		t.Fatalf("the engine refused the bills index: %v", err)
	}
	for start := 0; start < len(dataset.documents); start += searchesInsertBatch {
		end := min(start+searchesInsertBatch, len(dataset.documents))
		batch := make([]engine.Document, 0, end-start)
		for row := start; row < end; row++ {
			bill := dataset.documents[row]
			batch = append(batch, engine.Document{"id": bill.ID, "title": bill.Title, "summary": bill.Summary,
				expected.Vector.Field: dataset.vectors[row*datasetVectorDimension : (row+1)*datasetVectorDimension]})
		}
		result, err := narsil.InsertBatch(ctx, searchesIndexName, batch, engine.InsertOptions{})
		if err != nil || len(result.Failed) > 0 {
			t.Fatalf("the bills index refused documents: %v %+v", err, result.Failed)
		}
	}
	deadline := time.Now().Add(searchesGraphDeadline)
	for {
		statuses, err := narsil.VectorMaintenanceStatus(searchesIndexName)
		if err != nil {
			t.Fatalf("reading the vector status failed: %v", err)
		}
		settled := len(statuses) > 0
		for _, status := range statuses {
			settled = settled && !status.Building && status.GraphCount > 0
		}
		if settled {
			return narsil
		}
		if time.Now().After(deadline) {
			t.Fatalf("the bills index was still building its graph at the deadline: %+v", statuses)
		}
		time.Sleep(searchesGraphPoll)
	}
}

func cosineSimilarities(dataset conformanceDataset, query []float64) []float64 {
	var queryNorm float64
	for _, component := range query {
		queryNorm += component * component
	}
	queryNorm = math.Sqrt(queryNorm)
	similarities := make([]float64, len(dataset.documents))
	for row := range similarities {
		var dot, norm float64
		for component, value := range dataset.vectors[row*datasetVectorDimension : (row+1)*datasetVectorDimension] {
			dot += query[component] * float64(value)
			norm += float64(value) * float64(value)
		}
		if denominator := queryNorm * math.Sqrt(norm); denominator != 0 {
			similarities[row] = dot / denominator
		}
	}
	return similarities
}

func TestConformanceSearchesMatchTheReferenceOverThePinnedDataset(t *testing.T) {
	var expected expectedSearches
	readJSONFile(t, conformancePath("searches", "queries.json"), &expected)
	var pin datasetPin
	readJSONFile(t, conformancePath("dataset-pin.json"), &pin)
	if expected.Dataset != pin {
		t.Fatalf("queries.json was computed over %+v, while the pin gives %+v", expected.Dataset, pin)
	}
	dataset := loadConformanceDataset(t, fetchPinnedDataset(t))
	if len(expected.Text.Queries) != len(dataset.queries.TextQueries) || len(expected.Vector.Queries) != len(dataset.queries.VectorQueries) {
		t.Fatal("queries.json covers a different number of queries than the dataset holds")
	}
	ctx := context.Background()
	narsil := openBillsIndex(t, ctx, expected, dataset)
	for at, query := range expected.Text.Queries {
		if dataset.queries.TextQueries[at].Text != query.Text {
			t.Fatalf("text query %s differs from the dataset's query", query.ID)
		}
		result, err := narsil.Query(ctx, searchesIndexName, engine.QueryParams{Term: query.Text, Limit: engine.Some(expected.Text.Limit), IncludeScores: true})
		if err != nil {
			t.Fatalf("text query %s failed: %v", query.ID, err)
		}
		if len(result.Hits) != len(query.Hits) {
			t.Fatalf("text query %s returned %d hits, not %d", query.ID, len(result.Hits), len(query.Hits))
		}
		for rank, hit := range result.Hits {
			want := query.Hits[rank]
			score, scored := hit.Score.Get()
			if hit.ID != want.ID || !scored || math.Abs(score-want.Score) > searchesScoreTolerance*math.Max(1, math.Abs(want.Score)) {
				t.Fatalf("text query %s ranks %s with %v at %d, where the reference ranks %s with %v", query.ID, hit.ID, score, rank+1, want.ID, want.Score)
			}
		}
	}
	rows := map[string]int{}
	for row, document := range dataset.documents {
		rows[document.ID] = row
	}
	for _, floor := range expected.Vector.Floors {
		total := 0.0
		for at, query := range dataset.queries.VectorQueries {
			value := make([]float32, len(query.Vector))
			for component, number := range query.Vector {
				value[component] = float32(number)
			}
			result, err := narsil.Query(ctx, searchesIndexName, engine.QueryParams{Mode: engine.SearchVector, Limit: engine.Some(floor.K),
				Vector: &engine.VectorQueryConfig{Field: expected.Vector.Field, Value: value}})
			if err != nil {
				t.Fatalf("vector query %s failed: %v", query.ID, err)
			}
			similarities := cosineSimilarities(dataset, query.Vector)
			neighbours := expected.Vector.Queries[at].Neighbours
			threshold := neighbours[floor.K-1].Similarity - searchesSimilarityMargin
			seen := map[string]bool{}
			found := 0
			for _, hit := range result.Hits[:min(floor.K, len(result.Hits))] {
				row, known := rows[hit.ID]
				if !known {
					t.Fatalf("vector query %s returned %s, which the dataset does not hold", query.ID, hit.ID)
				}
				if !seen[hit.ID] && similarities[row] >= threshold {
					found++
				}
				seen[hit.ID] = true
			}
			total += float64(found) / float64(floor.K)
		}
		if recall := total / float64(len(dataset.queries.VectorQueries)); recall < floor.Floor {
			t.Fatalf("recall@%d is %.4f, below the floor of %.2f", floor.K, recall, floor.Floor)
		}
	}
}
