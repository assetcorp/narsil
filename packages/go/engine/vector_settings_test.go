package engine_test

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	vectorSettingsDimension      = 4
	documentsBelowPromotion      = 40
	documentsPastPromotion       = 300
	lowPromotionThreshold        = 64
	nearestNeighboursChecked     = 10
	oversampleFarPastEveryVector = 1e6
	scoreTolerance               = 1e-5
)

type vectorSettingsCase struct {
	name               string
	efSearch           engine.Optional[int]
	oversample         engine.Optional[float64]
	rescoresEverything bool
}

func refusedVectorSettings() []vectorSettingsCase {
	return []vectorSettingsCase{
		{name: "efSearch of 0", efSearch: engine.Some(0)},
		{name: "negative efSearch", efSearch: engine.Some(-1)},
		{name: "efSearch one past 10,000", efSearch: engine.Some(10_001)},
		{name: "efSearch far past 10,000", efSearch: engine.Some(math.MaxInt32)},
		{name: "oversample below 1", oversample: engine.Some(0.999)},
		{name: "oversample of 0", oversample: engine.Some(0.0)},
		{name: "negative oversample", oversample: engine.Some(-3.0)},
		{name: "oversample that is not a number", oversample: engine.Some(math.NaN())},
		{name: "infinite oversample", oversample: engine.Some(math.Inf(1))},
		{name: "negative infinite oversample", oversample: engine.Some(math.Inf(-1))},
	}
}

func catalogueVector(at int) []float32 {
	angle := float64(at) * 0.37
	return []float32{float32(math.Cos(angle)), float32(math.Sin(angle)), float32(at%7) / 7, 1}
}

func openCatalogue(t *testing.T, promotion *engine.VectorIndexConfig, documents int) *engine.Narsil {
	t.Helper()
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	schema := engine.Schema{
		"title":     engine.FieldString,
		"shelf":     engine.FieldEnum,
		"embedding": engine.VectorFieldType(vectorSettingsDimension),
	}
	if err := narsil.CreateIndex(ctx, "catalogue", engine.IndexConfig{Schema: schema, VectorPromotion: promotion}); err != nil {
		t.Fatalf("the engine refused the catalogue index: %v", err)
	}
	batch := make([]engine.Document, documents)
	for at := range batch {
		batch[at] = engine.Document{
			"id":        "item-" + strconv.Itoa(at),
			"title":     "lantern number " + strconv.Itoa(at),
			"shelf":     []string{"north", "south"}[at%2],
			"embedding": catalogueVector(at),
		}
	}
	result, err := narsil.InsertBatch(ctx, "catalogue", batch, engine.InsertOptions{})
	if err != nil {
		t.Fatalf("the catalogue refused its documents: %v", err)
	}
	if len(result.Failed) != 0 {
		t.Fatalf("the catalogue refused %d documents: %+v", len(result.Failed), result.Failed[0])
	}
	return narsil
}

func queriesCarrying(setting vectorSettingsCase) map[string]engine.QueryParams {
	clause := func() *engine.VectorQueryConfig {
		return &engine.VectorQueryConfig{Field: "embedding", Value: catalogueVector(3), EfSearch: setting.efSearch, Oversample: setting.oversample}
	}
	emptyShelf := &engine.FilterExpression{Fields: map[string]engine.FieldFilter{"shelf": {Eq: engine.TextValue("east")}}}
	return map[string]engine.QueryParams{
		"vector search": {Mode: engine.SearchVector, Vector: clause()},
		"vector search whose filter matches none": {Mode: engine.SearchVector, Vector: clause(), Filters: emptyShelf},
		"hybrid search": {Term: "lantern", Vector: clause()},
		"hybrid search whose filter matches none": {Term: "lantern", Vector: clause(), Filters: emptyShelf},
		"keyword search carrying a vector clause": {Term: "lantern", Mode: engine.SearchFulltext, Vector: clause()},
	}
}

func requireConfigInvalid(t *testing.T, operation string, err error) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s accepted the query", operation)
	}
	typed, isTyped := engine.AsError(err)
	if !isTyped {
		t.Fatalf("%s failed without an engine error: %v", operation, err)
	}
	if typed.Code != engine.CodeConfigInvalid {
		t.Fatalf("%s raised %s, not %s: %s", operation, typed.Code, engine.CodeConfigInvalid, typed.Message)
	}
}

func TestQueriesRefuseBadVectorSettingsWhateverTheIndexHolds(t *testing.T) {
	catalogues := map[string]func(*testing.T) *engine.Narsil{
		"a field below the promotion threshold": func(t *testing.T) *engine.Narsil {
			return openCatalogue(t, nil, documentsBelowPromotion)
		},
		"a field past a low promotion threshold": func(t *testing.T) *engine.Narsil {
			return openCatalogue(t, &engine.VectorIndexConfig{Threshold: engine.Some(lowPromotionThreshold)}, documentsPastPromotion)
		},
		"an empty index": func(t *testing.T) *engine.Narsil {
			return openCatalogue(t, nil, 0)
		},
	}
	for catalogueName, open := range catalogues {
		t.Run(catalogueName, func(t *testing.T) {
			narsil := open(t)
			ctx := context.Background()
			for _, setting := range refusedVectorSettings() {
				for queryName, params := range queriesCarrying(setting) {
					label := fmt.Sprintf("%s with %s", queryName, setting.name)
					_, err := narsil.Query(ctx, "catalogue", params)
					requireConfigInvalid(t, "Query of a "+label, err)
					_, err = narsil.Preflight(ctx, "catalogue", params)
					requireConfigInvalid(t, "Preflight of a "+label, err)
				}
			}
		})
	}
}

type expectedNeighbour struct {
	id    string
	score float64
}

func cosineOracle(query []float32, documents int) []expectedNeighbour {
	neighbours := make([]expectedNeighbour, documents)
	for at := range neighbours {
		candidate := catalogueVector(at)
		var dot, queryNorm, candidateNorm float64
		for d := range query {
			dot += float64(query[d]) * float64(candidate[d])
			queryNorm += float64(query[d]) * float64(query[d])
			candidateNorm += float64(candidate[d]) * float64(candidate[d])
		}
		neighbours[at] = expectedNeighbour{id: "item-" + strconv.Itoa(at), score: dot / math.Sqrt(queryNorm*candidateNorm)}
	}
	sort.SliceStable(neighbours, func(left, right int) bool { return neighbours[left].score > neighbours[right].score })
	return neighbours
}

func TestQueriesAcceptVectorSettingsAtTheEdgesOfTheirRange(t *testing.T) {
	narsil := openCatalogue(t, &engine.VectorIndexConfig{Threshold: engine.Some(lowPromotionThreshold)}, documentsPastPromotion)
	ctx := context.Background()
	query := catalogueVector(117)
	expected := cosineOracle(query, documentsPastPromotion)[:nearestNeighboursChecked]
	settings := []vectorSettingsCase{
		{name: "efSearch of 1", efSearch: engine.Some(1)},
		{name: "efSearch of 10,000", efSearch: engine.Some(10_000)},
		{name: "oversample of 1", oversample: engine.Some(1.0)},
		{name: "an oversample far past every vector the field holds", oversample: engine.Some(oversampleFarPastEveryVector),
			efSearch: engine.Some(10_000), rescoresEverything: true},
	}
	for _, setting := range settings {
		params := engine.QueryParams{
			Mode:          engine.SearchVector,
			Limit:         engine.Some(nearestNeighboursChecked),
			IncludeScores: true,
			Vector:        &engine.VectorQueryConfig{Field: "embedding", Value: query, EfSearch: setting.efSearch, Oversample: setting.oversample},
		}
		result, err := narsil.Query(ctx, "catalogue", params)
		if err != nil {
			t.Fatalf("a vector search with %s failed: %v", setting.name, err)
		}
		if len(result.Hits) == 0 {
			t.Fatalf("a vector search with %s returned no hits", setting.name)
		}
		if _, err := narsil.Preflight(ctx, "catalogue", params); err != nil {
			t.Fatalf("a preflight with %s failed: %v", setting.name, err)
		}
		if !setting.rescoresEverything {
			continue
		}
		if len(result.Hits) != nearestNeighboursChecked {
			t.Fatalf("a vector search with %s returned %d hits, not %d", setting.name, len(result.Hits), nearestNeighboursChecked)
		}
		for at, hit := range result.Hits {
			score, scored := hit.Score.Get()
			if !scored || math.Abs(score-expected[at].score) > scoreTolerance {
				t.Fatalf("a vector search with %s ranks %s at %d with score %v, while the exact cosine ranks %s there with %v",
					setting.name, hit.ID, at, score, expected[at].id, expected[at].score)
			}
		}
	}
}
