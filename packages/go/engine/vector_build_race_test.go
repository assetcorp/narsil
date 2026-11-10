package engine_test

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	placingIndexName           = "lanterns"
	placingDimension           = 16
	placingWriters             = 4
	placingSearchers           = 4
	placingSlotsPerWriter      = 600
	placingStepsPerWriter      = 250
	placingInsertBatch         = 40
	placingPromotionThreshold  = 32
	placingNearest             = 10
	placingExactEfSearch       = 10_000
	placingExactOversample     = 1e6
	placingScoreTolerance      = 1e-5
	placingQuiescentPause      = 30 * time.Millisecond
	placingStatusPause         = 2 * time.Millisecond
	placingRecentTargetShare   = 2
	placingInsertChoices       = 4
	placingUpdateChoices       = 3
	placingStepChoices         = 10
	placingWriterSeedBase      = 7_000
	placingSearcherSeedBase    = 8_000
	placingQuiescentSeed       = 9_000
	placingMinimumLiveForWrite = 2 * placingInsertBatch
)

type placingOracle struct {
	mu      sync.Mutex
	written map[string][][]float32
	live    map[string][]float32
}

func (oracle *placingOracle) recordWritten(id string, vector []float32) {
	oracle.mu.Lock()
	defer oracle.mu.Unlock()
	oracle.written[id] = append(oracle.written[id], vector)
}

func (oracle *placingOracle) everWritten(id string, vector []float32) bool {
	oracle.mu.Lock()
	defer oracle.mu.Unlock()
	for _, held := range oracle.written[id] {
		if sameVector(held, vector) {
			return true
		}
	}
	return false
}

func (oracle *placingOracle) setLive(id string, vector []float32) {
	oracle.mu.Lock()
	defer oracle.mu.Unlock()
	if vector == nil {
		delete(oracle.live, id)
		return
	}
	oracle.live[id] = vector
}

type placingRace struct {
	ctx          context.Context
	narsil       *engine.Narsil
	oracle       placingOracle
	gate         sync.RWMutex
	failure      atomic.Pointer[error]
	buildsSeen   atomic.Int64
	searchesDone atomic.Int64
}

func (race *placingRace) fail(err error) {
	if err != nil {
		race.failure.CompareAndSwap(nil, &err)
	}
}

func (race *placingRace) failed() bool {
	return race.failure.Load() != nil
}

type placingWriter struct {
	position int
	random   *rand.Rand
	live     map[int]bool
	recent   []int
}

func placingID(position int, slot int) string {
	return "w" + strconv.Itoa(position) + "-s" + strconv.Itoa(slot)
}

func randomUnitishVector(random *rand.Rand) []float32 {
	vector := make([]float32, placingDimension)
	for component := range vector {
		vector[component] = float32(random.Float64()*2 - 1)
	}
	vector[random.Intn(placingDimension)] += 2
	return vector
}

func sameVector(left []float32, right []float32) bool {
	if len(left) != len(right) {
		return false
	}
	for component := range left {
		if math.Float32bits(left[component]) != math.Float32bits(right[component]) {
			return false
		}
	}
	return true
}

func returnedEmbedding(document *engine.Document) ([]float32, bool) {
	if document == nil {
		return nil, false
	}
	embedding, _ := document.Get("embedding")
	switch held := embedding.(type) {
	case []float32:
		return held, true
	case []float64:
		vector := make([]float32, len(held))
		for component, value := range held {
			vector[component] = float32(value)
		}
		return vector, true
	case []any:
		vector := make([]float32, len(held))
		for component, value := range held {
			number, isNumber := value.(float64)
			if !isNumber {
				return nil, false
			}
			vector[component] = float32(number)
		}
		return vector, true
	}
	return nil, false
}

func (writer *placingWriter) target() (int, bool) {
	if len(writer.recent) > 0 && writer.random.Intn(placingRecentTargetShare) == 0 {
		slot := writer.recent[writer.random.Intn(len(writer.recent))]
		if writer.live[slot] {
			return slot, true
		}
	}
	slots := make([]int, 0, len(writer.live))
	for slot := range writer.live {
		slots = append(slots, slot)
	}
	if len(slots) == 0 {
		return 0, false
	}
	sort.Ints(slots)
	return slots[writer.random.Intn(len(slots))], true
}

func (race *placingRace) insertBatch(writer *placingWriter) error {
	start := writer.random.Intn(placingSlotsPerWriter)
	batch := []*engine.Document{}
	staged := map[int][]float32{}
	for offset := 0; offset < placingSlotsPerWriter && len(batch) < placingInsertBatch; offset++ {
		slot := (start + offset) % placingSlotsPerWriter
		if writer.live[slot] {
			continue
		}
		vector := randomUnitishVector(writer.random)
		id := placingID(writer.position, slot)
		race.oracle.recordWritten(id, vector)
		batch = append(batch, engine.DocumentFromMap(map[string]any{"id": id, "title": "lantern " + id, "embedding": vector}))
		staged[slot] = vector
	}
	result, err := race.narsil.InsertBatch(race.ctx, placingIndexName, batch, engine.InsertOptions{})
	if err != nil || len(result.Failed) > 0 {
		return fmt.Errorf("inserting %d documents failed: %v %+v", len(batch), err, result.Failed)
	}
	writer.recent = writer.recent[:0]
	for slot, vector := range staged {
		writer.live[slot] = true
		writer.recent = append(writer.recent, slot)
		race.oracle.setLive(placingID(writer.position, slot), vector)
	}
	return nil
}

func (race *placingRace) writerStep(writer *placingWriter) error {
	race.gate.RLock()
	defer race.gate.RUnlock()
	choice := writer.random.Intn(placingStepChoices)
	if len(writer.live) < placingMinimumLiveForWrite || choice < placingInsertChoices {
		return race.insertBatch(writer)
	}
	slot, found := writer.target()
	if !found {
		return race.insertBatch(writer)
	}
	id := placingID(writer.position, slot)
	if choice < placingInsertChoices+placingUpdateChoices {
		vector := randomUnitishVector(writer.random)
		race.oracle.recordWritten(id, vector)
		document := engine.DocumentFromMap(map[string]any{"title": "lantern " + id, "embedding": vector})
		if err := race.narsil.Update(race.ctx, placingIndexName, id, document, engine.WriteOptions{}); err != nil {
			return fmt.Errorf("updating %s failed: %w", id, err)
		}
		race.oracle.setLive(id, vector)
		return nil
	}
	if err := race.narsil.Remove(race.ctx, placingIndexName, id, engine.WriteOptions{}); err != nil {
		return fmt.Errorf("removing %s failed: %w", id, err)
	}
	delete(writer.live, slot)
	race.oracle.setLive(id, nil)
	return nil
}

func placingQuery(query []float32, exact bool) engine.QueryParams {
	clause := &engine.VectorQueryConfig{Field: "embedding", Value: query}
	if exact {
		clause.EfSearch = engine.Some(placingExactEfSearch)
		clause.Oversample = engine.Some(placingExactOversample)
	}
	return engine.QueryParams{Mode: engine.SearchVector, Limit: engine.Some(placingNearest), IncludeScores: true,
		Document: engine.IncludeFields("embedding"), Vector: clause}
}

func checkHitsMatchTheirVectors(label string, query []float32, hits []engine.Hit, accepted func(id string, vector []float32) bool) error {
	seen := map[string]bool{}
	previous := math.Inf(1)
	for position, hit := range hits {
		score, scored := hit.Score.Get()
		vector, carried := returnedEmbedding(hit.Document)
		if !scored || !carried {
			return fmt.Errorf("%s returned %s at %d without a score or an embedding", label, hit.ID, position)
		}
		if seen[hit.ID] {
			return fmt.Errorf("%s returned %s twice", label, hit.ID)
		}
		seen[hit.ID] = true
		if !accepted(hit.ID, vector) {
			return fmt.Errorf("%s returned %s with a vector that the oracle never gave it in this state", label, hit.ID)
		}
		if exact := exactCosine(query, vector); math.Abs(score-exact) > placingScoreTolerance {
			return fmt.Errorf("%s scored %s at %v, while the cosine of the vector returned with it is %v", label, hit.ID, score, exact)
		}
		if score > previous+placingScoreTolerance {
			return fmt.Errorf("%s ranks %s with score %v below a hit that scored %v", label, hit.ID, score, previous)
		}
		previous = score
	}
	return nil
}

func (race *placingRace) searcherStep(random *rand.Rand) error {
	query := randomUnitishVector(random)
	exact := random.Intn(2) == 0
	result, err := race.narsil.Query(race.ctx, placingIndexName, placingQuery(query, exact))
	if err != nil {
		return fmt.Errorf("a vector search during writes failed: %w", err)
	}
	race.searchesDone.Add(1)
	return checkHitsMatchTheirVectors("a vector search during writes", query, result.Hits, race.oracle.everWritten)
}

type placingNeighbour struct {
	id    string
	score float64
}

func bruteForceNearest(query []float32, live map[string][]float32) []placingNeighbour {
	neighbours := make([]placingNeighbour, 0, len(live))
	for id, vector := range live {
		neighbours = append(neighbours, placingNeighbour{id: id, score: exactCosine(query, vector)})
	}
	sort.Slice(neighbours, func(left, right int) bool { return neighbours[left].score > neighbours[right].score })
	return neighbours[:min(placingNearest, len(neighbours))]
}

func (race *placingRace) checkSettledState(random *rand.Rand) error {
	race.oracle.mu.Lock()
	live := make(map[string][]float32, len(race.oracle.live))
	for id, vector := range race.oracle.live {
		live[id] = vector
	}
	race.oracle.mu.Unlock()
	matchesLive := func(id string, vector []float32) bool {
		held, isLive := live[id]
		return isLive && sameVector(held, vector)
	}
	count, err := race.narsil.CountDocuments(race.ctx, placingIndexName)
	if err != nil {
		return err
	}
	if count != len(live) {
		return fmt.Errorf("the index counts %d documents, while the oracle holds %d", count, len(live))
	}
	query := randomUnitishVector(random)
	for _, exact := range []bool{false, true} {
		label := "a vector search between writes"
		if exact {
			label = "an exact vector search between writes"
		}
		result, err := race.narsil.Query(race.ctx, placingIndexName, placingQuery(query, exact))
		if err != nil {
			return fmt.Errorf("%s failed: %w", label, err)
		}
		if err := checkHitsMatchTheirVectors(label, query, result.Hits, matchesLive); err != nil {
			return err
		}
		if !exact {
			continue
		}
		expected := bruteForceNearest(query, live)
		if len(result.Hits) != len(expected) {
			return fmt.Errorf("%s returned %d hits, while the brute-force oracle finds %d", label, len(result.Hits), len(expected))
		}
		for position, hit := range result.Hits {
			score, _ := hit.Score.Get()
			if math.Abs(score-expected[position].score) > placingScoreTolerance {
				return fmt.Errorf("%s ranks %s at %d with score %v, while the brute-force oracle ranks %s there with %v", label,
					hit.ID, position, score, expected[position].id, expected[position].score)
			}
		}
	}
	return nil
}

func (race *placingRace) settledStep(random *rand.Rand) error {
	race.gate.Lock()
	defer race.gate.Unlock()
	return race.checkSettledState(random)
}

func (race *placingRace) watchBuilds() error {
	statuses, err := race.narsil.VectorMaintenanceStatus(placingIndexName)
	if err != nil {
		return err
	}
	for _, status := range statuses {
		if status.Building {
			race.buildsSeen.Add(1)
		}
	}
	return nil
}

func untilStopped(stop <-chan struct{}, pause time.Duration, step func() error, race *placingRace) {
	for !race.failed() {
		select {
		case <-stop:
			return
		case <-time.After(pause):
		}
		race.fail(step())
	}
}

func TestVectorSearchesAgreeWithTheirVectorsWhileTheGraphPlacesWrites(t *testing.T) {
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	schema := engine.Schema{"title": engine.FieldString, "embedding": engine.VectorFieldType(placingDimension)}
	promotion := &engine.VectorIndexConfig{Threshold: engine.Some(placingPromotionThreshold)}
	if err := narsil.CreateIndex(ctx, placingIndexName, engine.IndexConfig{Schema: schema, VectorPromotion: promotion}); err != nil {
		t.Fatalf("the engine refused the index: %v", err)
	}
	race := &placingRace{ctx: ctx, narsil: narsil,
		oracle: placingOracle{written: map[string][][]float32{}, live: map[string][]float32{}}}
	var writers, background sync.WaitGroup
	stop := make(chan struct{})
	for position := range placingWriters {
		writers.Add(1)
		go func(position int) {
			defer writers.Done()
			writer := &placingWriter{position: position, random: rand.New(rand.NewSource(int64(placingWriterSeedBase + position))),
				live: map[int]bool{}}
			for step := 0; step < placingStepsPerWriter && !race.failed(); step++ {
				race.fail(race.writerStep(writer))
			}
		}(position)
	}
	for searcher := range placingSearchers {
		background.Add(1)
		go func(searcher int) {
			defer background.Done()
			random := rand.New(rand.NewSource(int64(placingSearcherSeedBase + searcher)))
			for !race.failed() {
				select {
				case <-stop:
					return
				default:
				}
				race.fail(race.searcherStep(random))
			}
		}(searcher)
	}
	settledRandom := rand.New(rand.NewSource(placingQuiescentSeed))
	background.Add(2)
	go func() {
		defer background.Done()
		untilStopped(stop, placingQuiescentPause, func() error { return race.settledStep(settledRandom) }, race)
	}()
	go func() {
		defer background.Done()
		untilStopped(stop, placingStatusPause, race.watchBuilds, race)
	}()
	writers.Wait()
	close(stop)
	background.Wait()
	if failure := race.failure.Load(); failure != nil {
		t.Fatalf("a search disagreed with the oracle or an operation failed: %s: %v", codeOrMessage(*failure), *failure)
	}
	if race.buildsSeen.Load() == 0 || race.searchesDone.Load() == 0 {
		t.Fatalf("the run saw %d builds and %d searches, so no search overlapped a build", race.buildsSeen.Load(),
			race.searchesDone.Load())
	}
	if err := narsil.OptimizeVectors(ctx, placingIndexName, "embedding"); err != nil {
		t.Fatalf("finishing the graph failed: %v", err)
	}
	if err := race.checkSettledState(settledRandom); err != nil {
		t.Fatalf("the finished graph disagreed with the oracle: %v", err)
	}
}
