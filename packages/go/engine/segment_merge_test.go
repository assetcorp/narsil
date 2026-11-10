package engine_test

import (
	"context"
	"fmt"
	"math/rand/v2"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	mergeIndexName        = "ledgers"
	mergeShelves          = 37
	mergeDocuments        = 16_000
	mergeBatch            = 500
	mergeWordsPerDocument = 200
	mergeVocabulary       = 20_000
	mergeChanges          = 600
	mergeChangeBatch      = 20
	mergeQuietWait        = 1050 * time.Millisecond
	mergeChangePause      = 15 * time.Millisecond
	mergeSettleWait       = 3 * time.Second
	mergeSeed             = 1_740_174
	mergeShelfLimit       = 1_000
)

type mergeOracle map[string]int

func shelfToken(shelf int) string {
	return "shelfmark" + strconv.Itoa(shelf)
}

func mergeWord(random *rand.Rand) string {
	return "lex" + strconv.Itoa(random.IntN(mergeVocabulary))
}

func mergeDocument(id string, shelf int, random *rand.Rand) *engine.Document {
	words := make([]string, 0, mergeWordsPerDocument+1)
	words = append(words, shelfToken(shelf))
	for range mergeWordsPerDocument {
		words = append(words, mergeWord(random))
	}
	return engine.NewDocument().Set("id", id).Set("body", strings.Join(words, " "))
}

func insertMergeDocuments(ctx context.Context, narsil *engine.Narsil, oracle mergeOracle, random *rand.Rand) error {
	for first := 0; first < mergeDocuments; first += mergeBatch {
		batch := make([]*engine.Document, 0, mergeBatch)
		for number := first; number < first+mergeBatch; number++ {
			id := "ledger-" + strconv.Itoa(number)
			shelf := number % mergeShelves
			oracle[id] = shelf
			batch = append(batch, mergeDocument(id, shelf, random))
		}
		result, err := narsil.InsertBatch(ctx, mergeIndexName, batch, engine.InsertOptions{})
		if err != nil {
			return err
		}
		if len(result.Failed) > 0 {
			return fmt.Errorf("%d documents of a batch failed to insert", len(result.Failed))
		}
	}
	return nil
}

func changeWhileMerging(ctx context.Context, narsil *engine.Narsil, oracle mergeOracle, random *rand.Rand) error {
	ids := make([]string, 0, len(oracle))
	for id := range oracle {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	random.Shuffle(len(ids), func(left, right int) { ids[left], ids[right] = ids[right], ids[left] })
	for start := 0; start < mergeChanges; start += mergeChangeBatch {
		removed := ids[2*start : 2*start+mergeChangeBatch]
		if _, err := narsil.RemoveBatch(ctx, mergeIndexName, removed, engine.WriteOptions{}); err != nil {
			return err
		}
		for _, id := range removed {
			delete(oracle, id)
		}
		updates := make([]engine.DocumentUpdate, 0, mergeChangeBatch)
		for _, id := range ids[2*start+mergeChangeBatch : 2*start+2*mergeChangeBatch] {
			shelf := (oracle[id] + 1 + random.IntN(mergeShelves-1)) % mergeShelves
			oracle[id] = shelf
			updates = append(updates, engine.DocumentUpdate{DocID: id, Document: mergeDocument(id, shelf, random)})
		}
		if _, err := narsil.UpdateBatch(ctx, mergeIndexName, updates, engine.WriteOptions{}); err != nil {
			return err
		}
		time.Sleep(mergeChangePause)
	}
	return nil
}

func requireShelvesMatch(t *testing.T, label string, narsil *engine.Narsil, oracle mergeOracle) {
	t.Helper()
	expected := make([][]string, mergeShelves)
	for id, shelf := range oracle {
		expected[shelf] = append(expected[shelf], id)
	}
	for shelf := range mergeShelves {
		result, err := narsil.Query(context.Background(), mergeIndexName, engine.QueryParams{Term: shelfToken(shelf),
			Limit: engine.Some(mergeShelfLimit), Document: engine.NoDocumentFields()})
		if err != nil {
			t.Fatalf("%s: the search for shelf %d failed: %v", label, shelf, err)
		}
		found := make([]string, 0, len(result.Hits))
		for _, hit := range result.Hits {
			found = append(found, hit.ID)
		}
		slices.Sort(found)
		slices.Sort(expected[shelf])
		if !slices.Equal(found, expected[shelf]) {
			t.Fatalf("%s: the search for shelf %d returned %d documents, while %d documents sit on that shelf",
				label, shelf, len(found), len(expected[shelf]))
		}
	}
}

func mergeEngine(ctx context.Context, directory string) (*engine.Narsil, error) {
	config := engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}}
	if directory != "" {
		config.Durability = &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}
	}
	return engine.New(ctx, config)
}

func runSearchesAcrossMerges(t *testing.T, directory string) {
	ctx := context.Background()
	narsil, err := mergeEngine(ctx, directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := narsil.CreateIndex(ctx, mergeIndexName, engine.IndexConfig{Schema: engine.Schema{"body": engine.FieldString},
		Language: "english"}); err != nil {
		t.Fatal(err)
	}
	random := rand.New(rand.NewPCG(mergeSeed, mergeSeed))
	oracle := mergeOracle{}
	if err := insertMergeDocuments(ctx, narsil, oracle, random); err != nil {
		t.Fatal(err)
	}
	requireShelvesMatch(t, "after the documents arrived", narsil, oracle)
	time.Sleep(mergeQuietWait)
	if err := changeWhileMerging(ctx, narsil, oracle, random); err != nil {
		t.Fatal(err)
	}
	requireShelvesMatch(t, "right after removals and updates that met a merge", narsil, oracle)
	time.Sleep(mergeSettleWait)
	requireShelvesMatch(t, "once the writes went quiet", narsil, oracle)
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if directory == "" {
		return
	}
	reopened, err := mergeEngine(ctx, directory)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Shutdown(ctx) }()
	requireShelvesMatch(t, "after a restart", reopened, oracle)
}

func TestSearchesFindEveryDocumentWhileSegmentsMergeAfterWritesGoQuiet(t *testing.T) {
	t.Parallel()
	t.Run("in memory", func(t *testing.T) {
		t.Parallel()
		runSearchesAcrossMerges(t, "")
	})
	t.Run("durable", func(t *testing.T) {
		t.Parallel()
		runSearchesAcrossMerges(t, t.TempDir())
	})
}
