package engine_test

import (
	"context"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	visibleDocuments          = 4_000
	visibleWaveDocuments      = 160
	visiblePromotionThreshold = 128
	visibleSearchers          = 4
	visibleSearcherStride     = 37
	visibleStatusPause        = time.Millisecond
)

type visibleRace struct {
	ctx            context.Context
	narsil         *engine.Narsil
	vectors        [][]float32
	numbers        map[string]int
	acknowledged   atomic.Int64
	writing        atomic.Bool
	building       atomic.Bool
	failure        atomic.Pointer[error]
	queriesInPass  atomic.Int64
	passesObserved atomic.Int64
}

func newVisibleRace(ctx context.Context, narsil *engine.Narsil) *visibleRace {
	race := &visibleRace{ctx: ctx, narsil: narsil, vectors: make([][]float32, visibleDocuments),
		numbers: make(map[string]int, visibleDocuments)}
	for number := range visibleDocuments {
		race.vectors[number] = reachVector(number)
		race.numbers[reachID(number)] = number
	}
	return race
}

func (race *visibleRace) fail(err error) {
	if err != nil {
		race.failure.CompareAndSwap(nil, &err)
	}
}

func (race *visibleRace) failed() bool {
	return race.failure.Load() != nil
}

func (race *visibleRace) nearest(query []float32, candidates int) (string, float64) {
	bestID, bestScore := "", math.Inf(-1)
	for number := range min(candidates, visibleDocuments) {
		if score := exactCosine(query, race.vectors[number]); score > bestScore {
			bestID, bestScore = reachID(number), score
		}
	}
	return bestID, bestScore
}

func (race *visibleRace) findItself(number int) error {
	query := race.vectors[number]
	inPass := race.building.Load()
	result, err := race.narsil.Query(race.ctx, reachIndexName, placingQuery(query, true))
	if err != nil {
		return fmt.Errorf("the search for %s failed with %s: %w", reachID(number), codeOrMessage(err), err)
	}
	mayHold := int(race.acknowledged.Load()) + visibleWaveDocuments
	if inPass && race.building.Load() {
		race.queriesInPass.Add(1)
	}
	expectedID, expectedScore := race.nearest(query, mayHold)
	if len(result.Hits) == 0 {
		return fmt.Errorf("the search for %s returned no hits, while the brute-force oracle ranks %s first", reachID(number), expectedID)
	}
	score, _ := result.Hits[0].Score.Get()
	if result.Hits[0].ID != expectedID || math.Abs(score-expectedScore) > placingScoreTolerance {
		return fmt.Errorf("the search for %s ranked %s first with score %v, while the brute-force oracle ranks %s first with %v",
			reachID(number), result.Hits[0].ID, score, expectedID, expectedScore)
	}
	written := func(id string, vector []float32) bool {
		held, known := race.numbers[id]
		return known && held < mayHold && sameVector(race.vectors[held], vector)
	}
	return checkHitsMatchTheirVectors("the search for "+reachID(number), query, result.Hits, written)
}

func (race *visibleRace) search(searcher int) {
	for position := searcher; !race.failed(); position += visibleSearcherStride {
		if !race.writing.Load() && !race.building.Load() {
			return
		}
		race.fail(race.findItself(position % int(race.acknowledged.Load())))
	}
}

func (race *visibleRace) watchPasses(stop <-chan struct{}) {
	for !race.failed() {
		select {
		case <-stop:
			return
		case <-time.After(visibleStatusPause):
		}
		statuses, err := race.narsil.VectorMaintenanceStatus(reachIndexName)
		if err != nil || len(statuses) != 1 {
			race.fail(fmt.Errorf("the index reports %d vector fields: %v", len(statuses), err))
			return
		}
		if !statuses[0].Building {
			race.building.Store(false)
			continue
		}
		if !race.building.Swap(true) {
			race.passesObserved.Add(1)
		}
	}
}

func TestEveryAcknowledgedVectorFindsItselfWhileGrowthPassesPlaceNewOnes(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	promotion := &engine.VectorIndexConfig{Threshold: engine.Some(visiblePromotionThreshold),
		HNSW: &engine.HNSWConfig{M: engine.Some(reachGraphM)}}
	schema := engine.Schema{reachFieldName: engine.VectorFieldType(reachDimension)}
	if err := narsil.CreateIndex(ctx, reachIndexName, engine.IndexConfig{Schema: schema, VectorPromotion: promotion}); err != nil {
		t.Fatalf("creating the index failed: %v", err)
	}
	if err := insertReachWave(ctx, narsil, 0, visibleWaveDocuments); err != nil {
		t.Fatalf("the first wave failed: %v", err)
	}
	race := newVisibleRace(ctx, narsil)
	race.acknowledged.Store(visibleWaveDocuments)
	race.writing.Store(true)
	stop := make(chan struct{})
	var watching, searching sync.WaitGroup
	watching.Add(1)
	go func() {
		defer watching.Done()
		race.watchPasses(stop)
	}()
	for searcher := range visibleSearchers {
		searching.Add(1)
		go func() {
			defer searching.Done()
			race.search(searcher)
		}()
	}
	for first := visibleWaveDocuments; first < visibleDocuments && !race.failed(); first += visibleWaveDocuments {
		if err := insertReachWave(ctx, narsil, first, visibleWaveDocuments); err != nil {
			race.fail(fmt.Errorf("the wave from %d failed with %s: %w", first, codeOrMessage(err), err))
			break
		}
		race.acknowledged.Add(visibleWaveDocuments)
	}
	race.writing.Store(false)
	searching.Wait()
	close(stop)
	watching.Wait()
	if failure := race.failure.Load(); failure != nil {
		t.Fatal(*failure)
	}
	if race.passesObserved.Load() == 0 || race.queriesInPass.Load() < visibleDocuments/visibleWaveDocuments {
		t.Fatalf("the run saw %d growth passes and %d searches that began and ended while one ran, so too few searches overlapped a pass",
			race.passesObserved.Load(), race.queriesInPass.Load())
	}
	if err := narsil.OptimizeVectors(ctx, reachIndexName, reachFieldName); err != nil {
		t.Fatalf("finishing the graph failed: %v", err)
	}
	for number := range visibleDocuments {
		if err := race.findItself(number); err != nil {
			t.Fatalf("once the graph holds every vector, %v", err)
		}
	}
}
