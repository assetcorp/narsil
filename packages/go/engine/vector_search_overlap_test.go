package engine_test

import (
	"context"
	"fmt"
	"math/rand"
	"runtime"
	"sync"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	overlapWriters             = 2
	overlapSeedingWriter       = overlapWriters
	overlapSearchers           = 4
	overlapReaders             = 4
	overlapSearchesPerSearcher = 150
	overlapSlotsPerWriter      = 96
	overlapWriteBatch          = 8
	overlapPromotionThreshold  = 16
	overlapNoPause             = 0
	overlapWriterSeedBase      = 11_000
	overlapSearcherSeedBase    = 12_000
	overlapReaderSeedBase      = 13_000
)

func overlapID(writer int, slot int) string {
	return fmt.Sprintf("harbour-%d-%d", writer, slot)
}

func overlapInserts(race *placingRace, writer int, random *rand.Rand, first int) error {
	documents := make([]*engine.Document, 0, overlapWriteBatch)
	for offset := range overlapWriteBatch {
		id := overlapID(writer, first+offset)
		vector := randomUnitishVector(random)
		race.oracle.recordWritten(id, vector)
		documents = append(documents, engine.DocumentFromMap(map[string]any{"id": id, "title": "harbour " + id, "embedding": vector}))
	}
	result, err := race.narsil.InsertBatch(race.ctx, placingIndexName, documents, engine.InsertOptions{})
	if err != nil || len(result.Failed) > 0 {
		return fmt.Errorf("inserting %d documents failed: %v %+v", len(documents), err, result.Failed)
	}
	return nil
}

func overlapUpdates(race *placingRace, writer int, random *rand.Rand, first int) error {
	updates := make([]engine.DocumentUpdate, 0, overlapWriteBatch)
	for offset := range overlapWriteBatch {
		id := overlapID(writer, (first+offset)%overlapSlotsPerWriter)
		vector := randomUnitishVector(random)
		race.oracle.recordWritten(id, vector)
		updates = append(updates, engine.DocumentUpdate{DocID: id,
			Document: engine.DocumentFromMap(map[string]any{"title": "harbour " + id, "embedding": vector})})
	}
	result, err := race.narsil.UpdateBatch(race.ctx, placingIndexName, updates, engine.WriteOptions{})
	if err != nil || len(result.Failed) > 0 {
		return fmt.Errorf("updating %d documents failed: %v %+v", len(updates), err, result.Failed)
	}
	return nil
}

func overlapWrite(race *placingRace, writer int, random *rand.Rand, first int) error {
	if first < overlapSlotsPerWriter {
		return overlapInserts(race, writer, random, first)
	}
	return overlapUpdates(race, writer, random, first)
}

func overlapRead(race *placingRace, random *rand.Rand) error {
	id := overlapID(random.Intn(overlapSeedingWriter+1), random.Intn(overlapSlotsPerWriter))
	document, held, err := race.narsil.Get(race.ctx, placingIndexName, id)
	if err != nil {
		return fmt.Errorf("reading %s while vector searches ran failed: %w", id, err)
	}
	if !held {
		return nil
	}
	vector, carried := returnedEmbedding(document)
	if !carried || !race.oracle.everWritten(id, vector) {
		return fmt.Errorf("reading %s returned a vector that was never written to it", id)
	}
	return nil
}

func TestVectorSearchesStayCorrectWhileDocumentReadsAndVectorUpdatesOverlap(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	defer func() { _ = narsil.Shutdown(context.Background()) }()
	schema := engine.Schema{"title": engine.FieldString, "embedding": engine.VectorFieldType(placingDimension)}
	promotion := &engine.VectorIndexConfig{Threshold: engine.Some(overlapPromotionThreshold)}
	if err := narsil.CreateIndex(ctx, placingIndexName, engine.IndexConfig{Schema: schema, VectorPromotion: promotion}); err != nil {
		t.Fatalf("the engine refused the index: %v", err)
	}
	race := &placingRace{ctx: ctx, narsil: narsil,
		oracle: placingOracle{written: map[string][][]float32{}, live: map[string][]float32{}}}
	seeding := rand.New(rand.NewSource(overlapWriterSeedBase + overlapSeedingWriter))
	for first := 0; first < overlapSlotsPerWriter; first += overlapWriteBatch {
		if err := overlapInserts(race, overlapSeedingWriter, seeding, first); err != nil {
			t.Fatalf("seeding the index failed: %v", err)
		}
	}
	stop := make(chan struct{})
	var searchers, background sync.WaitGroup
	for searcher := range overlapSearchers {
		searchers.Add(1)
		go func(searcher int) {
			defer searchers.Done()
			random := rand.New(rand.NewSource(int64(overlapSearcherSeedBase + searcher)))
			for range overlapSearchesPerSearcher {
				if race.failed() {
					return
				}
				race.fail(race.searcherStep(random))
			}
		}(searcher)
	}
	writes := make([]int, overlapWriters)
	for writer := range overlapWriters {
		background.Add(1)
		go func(writer int) {
			defer background.Done()
			random := rand.New(rand.NewSource(int64(overlapWriterSeedBase + writer)))
			untilStopped(stop, overlapNoPause, func() error {
				err := overlapWrite(race, writer, random, writes[writer]*overlapWriteBatch)
				writes[writer]++
				return err
			}, race)
		}(writer)
	}
	for reader := range overlapReaders {
		background.Add(1)
		go func(reader int) {
			defer background.Done()
			random := rand.New(rand.NewSource(int64(overlapReaderSeedBase + reader)))
			untilStopped(stop, overlapNoPause, func() error { return overlapRead(race, random) }, race)
		}(reader)
	}
	background.Add(1)
	go func() {
		defer background.Done()
		untilStopped(stop, overlapNoPause, func() error {
			runtime.GC()
			return nil
		}, race)
	}()
	searchers.Wait()
	close(stop)
	background.Wait()
	if failure := race.failure.Load(); failure != nil {
		t.Fatalf("a vector search or a document read failed while vector updates ran: %s: %v", codeOrMessage(*failure), *failure)
	}
	for writer, finished := range writes {
		if finished == 0 {
			t.Fatalf("writer %d finished no write, so no search overlapped a vector update", writer)
		}
	}
}
