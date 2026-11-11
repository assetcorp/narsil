package engine_test

import (
	"context"
	"fmt"
	"math/rand"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	publishRaceIndexName  = "slipway"
	publishRaceStable     = 64
	publishRaceChurned    = 384
	publishRaceRounds     = 10
	publishRaceSeed       = 9_311
	publishRacePromotion  = 16
	publishRaceWakeFields = 4
)

type publishRace struct {
	ctx      context.Context
	narsil   *engine.Narsil
	versions map[string][][]float32
	wakes    []string
	churned  []string
	done     atomic.Bool
	mu       sync.Mutex
	failure  error
}

func (race *publishRace) fail(err error) {
	race.mu.Lock()
	defer race.mu.Unlock()
	if race.failure == nil {
		race.failure = err
	}
	race.done.Store(true)
}

func randomUnitVector(random *rand.Rand) []float32 {
	vector := make([]float32, pinnedDimension)
	for component := range vector {
		vector[component] = float32(random.Float64()*2 - 1)
	}
	return vector
}

func (race *publishRace) document(random *rand.Rand, id string, version int) map[string]any {
	fields := map[string]any{"embedding": race.versions[id][version]}
	for _, wake := range race.wakes {
		fields[wake] = randomUnitVector(random)
	}
	return fields
}

func openPublishRace(t *testing.T) *publishRace {
	t.Helper()
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	race := &publishRace{ctx: ctx, narsil: narsil, versions: map[string][][]float32{}}
	schema := engine.Schema{"embedding": engine.VectorFieldType(pinnedDimension)}
	for position := range publishRaceWakeFields {
		wake := "wake" + strconv.Itoa(position)
		race.wakes = append(race.wakes, wake)
		schema[wake] = engine.VectorFieldType(pinnedDimension)
	}
	promotion := &engine.VectorIndexConfig{Threshold: engine.Some(publishRacePromotion)}
	if err := narsil.CreateIndex(ctx, publishRaceIndexName, engine.IndexConfig{Schema: schema, VectorPromotion: promotion}); err != nil {
		t.Fatalf("the engine refused the index: %v", err)
	}
	random := rand.New(rand.NewSource(publishRaceSeed))
	documents := make([]*engine.Document, 0, publishRaceStable+publishRaceChurned)
	for position := range publishRaceStable + publishRaceChurned {
		id := "keel-" + strconv.Itoa(position)
		versions := 1
		if position >= publishRaceStable {
			id = "hull-" + strconv.Itoa(position)
			race.churned = append(race.churned, id)
			versions = publishRaceRounds + 1
		}
		for range versions {
			race.versions[id] = append(race.versions[id], randomUnitVector(random))
		}
		fields := race.document(random, id, 0)
		fields["id"] = id
		documents = append(documents, engine.DocumentFromMap(fields))
	}
	if result, err := narsil.InsertBatch(ctx, publishRaceIndexName, documents, engine.InsertOptions{}); err != nil || len(result.Failed) > 0 {
		t.Fatalf("loading the slipway failed: %v %+v", err, result.Failed)
	}
	if err := narsil.OptimizeVectors(ctx, publishRaceIndexName, "embedding"); err != nil {
		t.Fatalf("building the graph failed: %v", err)
	}
	return race
}

func (race *publishRace) churn(random *rand.Rand) {
	defer race.done.Store(true)
	for round := 1; round <= publishRaceRounds && !race.done.Load(); round++ {
		updates := make([]engine.DocumentUpdate, len(race.churned))
		for position, id := range race.churned {
			updates[position] = engine.DocumentUpdate{DocID: id, Document: engine.DocumentFromMap(race.document(random, id, round))}
		}
		if result, err := race.narsil.UpdateBatch(race.ctx, publishRaceIndexName, updates, engine.WriteOptions{}); err != nil ||
			len(result.Failed) > 0 {
			race.fail(fmt.Errorf("moving the hulls in round %d failed: %v %+v", round, err, result.Failed))
			return
		}
	}
}

func (race *publishRace) givenVector(id string, vector []float32) bool {
	for _, version := range race.versions[id] {
		if sameVector(version, vector) {
			return true
		}
	}
	return false
}

func (race *publishRace) searchEveryVector(query []float32) error {
	params := placingQuery(query, true)
	params.Limit = engine.Some(len(race.versions))
	result, err := race.narsil.Query(race.ctx, publishRaceIndexName, params)
	if err != nil {
		return fmt.Errorf("the search failed: %s: %v", codeOrMessage(err), err)
	}
	if err := checkHitsMatchTheirVectors("the search", query, result.Hits, race.givenVector); err != nil {
		return err
	}
	if len(result.Hits) != len(race.versions) {
		return fmt.Errorf("the search found %d of the %d acknowledged vectors, so a vector that its search still reads was freed",
			len(result.Hits), len(race.versions))
	}
	return nil
}

func (race *publishRace) compactThenSearch(random *rand.Rand) {
	for !race.done.Load() {
		if err := race.narsil.OptimizeVectors(race.ctx, publishRaceIndexName, "embedding"); err != nil {
			race.fail(fmt.Errorf("compacting the embeddings while it optimises them failed: %v", err))
			return
		}
		if err := race.searchEveryVector(randomUnitVector(random)); err != nil {
			race.fail(err)
			return
		}
	}
}

func TestARetiredVectorOutlivesCompactionUntilItsWritePublishes(t *testing.T) {
	race := openPublishRace(t)
	var group sync.WaitGroup
	group.Add(2)
	go func() { defer group.Done(); race.churn(rand.New(rand.NewSource(publishRaceSeed + 1))) }()
	go func() { defer group.Done(); race.compactThenSearch(rand.New(rand.NewSource(publishRaceSeed + 2))) }()
	group.Wait()
	if race.failure != nil {
		t.Fatal(race.failure)
	}
	if err := race.narsil.CompactVectors(race.ctx, publishRaceIndexName, "embedding"); err != nil {
		t.Fatalf("the final compaction failed: %v", err)
	}
	for id, versions := range race.versions {
		query := versions[len(versions)-1]
		result, err := race.narsil.Query(race.ctx, publishRaceIndexName, placingQuery(query, true))
		if err != nil {
			t.Fatalf("the settled search for %s failed: %v", id, err)
		}
		if len(result.Hits) == 0 || result.Hits[0].ID != id {
			t.Fatalf("the settled search for %s missed its latest vector at the top", id)
		}
	}
}
