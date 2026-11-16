package engine_test

import (
	"context"
	"fmt"
	"maps"
	"math"
	"math/rand/v2"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	borrowIndexName         = "catalogue"
	borrowShelves           = 60
	borrowPartialAddedWords = 50
	borrowPartialLimit      = 10_000
	borrowSeedBatches       = 8
	borrowDiskSeedBatches   = 4
	borrowBatchDocuments    = 600
	borrowWords             = 40
	borrowVocabulary        = 5_000
	borrowChangeRounds      = 120
	borrowChangeBatch       = 4
	borrowSwitchRound       = 20
	borrowChangePause       = 3 * time.Millisecond
	borrowCheckpointPause   = 40 * time.Millisecond
	borrowShelfLimit        = 1_000
	borrowSuggestLimit      = 100
	borrowSeed              = 2_026_111
	borrowShelfPrefix       = "shelfmark"
	plainTokenizerName      = "plain"
	markedTokenizerName     = "marked"
	markedTokenPrefix       = "m"
	borrowNoMutationTrigger = 1_000_000_000
	borrowScoreTolerance    = 1e-12
	borrowIdleMergeDelay    = time.Second
	borrowIdleRounds        = 8
	borrowIdleSwitchRound   = 2
	borrowIdleRemovals      = 8
	borrowIdleUpdates       = 72
)

type shelfTokenizer struct {
	prefix string
}

func (s shelfTokenizer) Tokenize(text string) []engine.Token {
	words := strings.Fields(text)
	tokens := make([]engine.Token, len(words))
	for at, word := range words {
		tokens[at] = engine.Token{Token: s.prefix + word, Position: at}
	}
	return tokens
}

type borrowOracle struct {
	shelves map[string]int
	random  *rand.Rand
	unused  []string
}

func (o *borrowOracle) document(id string, shelf int) *engine.Document {
	words := make([]string, 0, borrowWords+1)
	words = append(words, borrowShelfPrefix+strconv.Itoa(shelf))
	for range borrowWords {
		words = append(words, "lex"+strconv.Itoa(o.random.IntN(borrowVocabulary)))
	}
	o.shelves[id] = shelf
	return engine.NewDocument().Set("id", id).Set("body", strings.Join(words, " "))
}

func (o *borrowOracle) movedShelf(id string) int {
	return (o.shelves[id] + 1 + o.random.IntN(borrowShelves-1)) % borrowShelves
}

func (o *borrowOracle) take(count int) []string {
	taken := o.unused[:count]
	o.unused = o.unused[count:]
	return taken
}

type borrowVariant struct {
	name    string
	storage engine.TextStorage
	durable bool
	batches int
}

func openBorrowEngine(ctx context.Context, directory string) (*engine.Narsil, error) {
	config := engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Tokenizers: map[string]engine.Tokenizer{plainTokenizerName: shelfTokenizer{},
			markedTokenizerName: shelfTokenizer{prefix: markedTokenPrefix}}}
	if directory != "" {
		config.Durability = &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
			CheckpointInterval:          engine.Some(time.Duration(0)),
			CheckpointMutationThreshold: engine.Some(borrowNoMutationTrigger)}
	}
	return engine.New(ctx, config)
}

func seedFrozenSegments(ctx context.Context, narsil *engine.Narsil, oracle *borrowOracle, variant borrowVariant) error {
	for batch := range variant.batches {
		documents := make([]*engine.Document, 0, borrowBatchDocuments)
		for number := batch * borrowBatchDocuments; number < (batch+1)*borrowBatchDocuments; number++ {
			id := "item-" + strconv.Itoa(number)
			documents = append(documents, oracle.document(id, number%borrowShelves))
		}
		result, err := narsil.InsertBatch(ctx, borrowIndexName, documents, engine.InsertOptions{})
		if err != nil {
			return err
		}
		if len(result.Failed) > 0 {
			return fmt.Errorf("%d documents of a batch failed to insert", len(result.Failed))
		}
		if !variant.durable {
			continue
		}
		if err := narsil.Checkpoint(ctx, borrowIndexName); err != nil {
			return err
		}
	}
	oracle.unused = slices.Sorted(maps.Keys(oracle.shelves))
	oracle.random.Shuffle(len(oracle.unused), func(left, right int) {
		oracle.unused[left], oracle.unused[right] = oracle.unused[right], oracle.unused[left]
	})
	return nil
}

func updateTwice(ctx context.Context, narsil *engine.Narsil, oracle *borrowOracle, ids []string) error {
	for range 2 {
		updates := make([]engine.DocumentUpdate, 0, len(ids))
		for _, id := range ids {
			updates = append(updates, engine.DocumentUpdate{DocID: id, Document: oracle.document(id, oracle.movedShelf(id))})
		}
		result, err := narsil.UpdateBatch(ctx, borrowIndexName, updates, engine.WriteOptions{})
		if err != nil {
			return err
		}
		if len(result.Failed) > 0 {
			return fmt.Errorf("%d updates failed", len(result.Failed))
		}
	}
	return nil
}

func changeWhileCheckpointing(ctx context.Context, narsil *engine.Narsil, oracle *borrowOracle,
	switchAnalysis func()) error {
	done := make(chan struct{})
	checkpoints := make(chan error, 1)
	go func() {
		for {
			select {
			case <-done:
				checkpoints <- nil
				return
			case <-time.After(borrowCheckpointPause):
			}
			if err := narsil.Checkpoint(ctx, borrowIndexName); err != nil {
				checkpoints <- err
				return
			}
		}
	}()
	err := changeDocuments(ctx, narsil, oracle, checkpointedPace, switchAnalysis)
	close(done)
	if checkpointErr := <-checkpoints; err == nil {
		err = checkpointErr
	}
	return err
}

type changePace struct {
	rounds      int
	switchRound int
	removals    int
	updates     int
	pause       time.Duration
}

var (
	checkpointedPace  = changePace{rounds: borrowChangeRounds, switchRound: borrowSwitchRound, removals: borrowChangeBatch, updates: borrowChangeBatch, pause: borrowChangePause}
	idleMergeMeetPace = changePace{rounds: borrowIdleRounds, switchRound: borrowIdleSwitchRound, removals: borrowIdleRemovals, updates: borrowIdleUpdates, pause: borrowIdleMergeDelay}
)

func changeDocuments(ctx context.Context, narsil *engine.Narsil, oracle *borrowOracle, pace changePace,
	switchAnalysis func()) error {
	for round := range pace.rounds {
		if round == pace.switchRound && switchAnalysis != nil {
			switchAnalysis()
		}
		removed := oracle.take(pace.removals)
		if _, err := narsil.RemoveBatch(ctx, borrowIndexName, removed, engine.WriteOptions{}); err != nil {
			return err
		}
		for _, id := range removed {
			delete(oracle.shelves, id)
		}
		if err := updateTwice(ctx, narsil, oracle, oracle.take(pace.updates)); err != nil {
			return err
		}
		time.Sleep(pace.pause)
	}
	return nil
}

func changeDuringBackgroundWork(ctx context.Context, narsil *engine.Narsil, oracle *borrowOracle, variant borrowVariant,
	switchAnalysis func()) error {
	if variant.durable {
		return changeWhileCheckpointing(ctx, narsil, oracle, switchAnalysis)
	}
	return changeDocuments(ctx, narsil, oracle, idleMergeMeetPace, switchAnalysis)
}

func requireBorrowShelves(t *testing.T, label string, narsil *engine.Narsil, oracle *borrowOracle) {
	t.Helper()
	ctx := context.Background()
	expected := make([][]string, borrowShelves)
	counts := map[string]int{}
	for id, shelf := range oracle.shelves {
		expected[shelf] = append(expected[shelf], id)
		counts[strconv.Itoa(shelf)]++
	}
	for shelf := range borrowShelves {
		result, err := narsil.Query(ctx, borrowIndexName, engine.QueryParams{Term: borrowShelfPrefix + strconv.Itoa(shelf),
			Limit: engine.Some(borrowShelfLimit), Document: engine.NoDocumentFields()})
		if err != nil {
			t.Fatalf("%s: the search for shelf %d failed: %v", label, shelf, err)
		}
		live, holding := float64(len(oracle.shelves)), float64(len(expected[shelf]))
		idf := math.Log((((live - holding) + 0.5) / (holding + 0.5)) + 1)
		found := make([]string, 0, len(result.Hits))
		for _, hit := range result.Hits {
			found = append(found, hit.ID)
			if score, scored := hit.Score.Get(); !scored || math.Abs(score-idf) > borrowScoreTolerance*idf {
				t.Fatalf("%s: %s on shelf %d scores %v, while %d of %d documents on that shelf give it %v",
					label, hit.ID, shelf, score, len(expected[shelf]), len(oracle.shelves), idf)
			}
		}
		slices.Sort(found)
		slices.Sort(expected[shelf])
		if !slices.Equal(found, expected[shelf]) {
			t.Fatalf("%s: the search for shelf %d returned %d documents, while %d documents sit on that shelf",
				label, shelf, len(found), len(expected[shelf]))
		}
	}
	suggested, err := narsil.Suggest(ctx, borrowIndexName, engine.SuggestParams{Prefix: markedTokenPrefix + borrowShelfPrefix,
		Limit: engine.Some(borrowSuggestLimit)})
	if err != nil {
		t.Fatalf("%s: the suggestions failed: %v", label, err)
	}
	reported := map[string]int{}
	for _, term := range suggested.Terms {
		reported[strings.TrimPrefix(term.Term, markedTokenPrefix+borrowShelfPrefix)] = term.DocumentFrequency
	}
	if !maps.Equal(reported, counts) {
		t.Fatalf("%s: the suggestions count %v documents per shelf, while the shelves hold %v", label, reported, counts)
	}
	requirePartialWordShelves(t, label, narsil, expected)
}

func requirePartialWordShelves(t *testing.T, label string, narsil *engine.Narsil, expected [][]string) {
	t.Helper()
	spelling := func(shelf int) string { return markedTokenPrefix + borrowShelfPrefix + strconv.Itoa(shelf) }
	ranked := make([]int, 0, borrowShelves)
	for shelf := range borrowShelves {
		if len(expected[shelf]) > 0 {
			ranked = append(ranked, shelf)
		}
	}
	slices.SortFunc(ranked, func(left, right int) int {
		if held := len(expected[right]) - len(expected[left]); held != 0 {
			return held
		}
		return strings.Compare(spelling(left), spelling(right))
	})
	var reached []string
	for _, shelf := range ranked[:min(len(ranked), borrowPartialAddedWords)] {
		reached = append(reached, expected[shelf]...)
	}
	slices.Sort(reached)
	result, err := narsil.Query(context.Background(), borrowIndexName, engine.QueryParams{Term: borrowShelfPrefix,
		PartialWords: true, Tolerance: engine.Some(0), Limit: engine.Some(borrowPartialLimit),
		Document: engine.NoDocumentFields()})
	if err != nil {
		t.Fatalf("%s: the partial-word search failed: %v", label, err)
	}
	found := make([]string, 0, len(result.Hits))
	for _, hit := range result.Hits {
		found = append(found, hit.ID)
	}
	slices.Sort(found)
	if !slices.Equal(found, reached) {
		t.Fatalf("%s: the partial-word search for %q returned %d documents, while the %d shelves that hold the most documents hold %d",
			label, borrowShelfPrefix, len(found), borrowPartialAddedWords, len(reached))
	}
}

func runBorrowedTokensAcrossMerges(t *testing.T, variant borrowVariant) {
	ctx := context.Background()
	directory := ""
	if variant.durable {
		directory = t.TempDir()
	}
	narsil, err := openBorrowEngine(ctx, directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := narsil.CreateIndex(ctx, borrowIndexName, engine.IndexConfig{
		Schema:    engine.Schema{"body": engine.FieldString.WithOptions(engine.TextFieldPartial)},
		Tokenizer: engine.NamedTokenizer(plainTokenizerName), TextStorage: variant.storage}); err != nil {
		t.Fatal(err)
	}
	oracle := &borrowOracle{shelves: map[string]int{}, random: rand.New(rand.NewPCG(borrowSeed, borrowSeed))}
	if err := seedFrozenSegments(ctx, narsil, oracle, variant); err != nil {
		t.Fatal(err)
	}
	if !variant.durable {
		time.Sleep(borrowIdleMergeDelay)
	}
	switched := make(chan error, 1)
	switchAnalysis := func() {
		go func() {
			switched <- narsil.ChangeAnalysis(ctx, borrowIndexName,
				engine.AnalysisChange{Tokenizer: engine.ChangeToRegisteredTokenizer(markedTokenizerName)})
		}()
	}
	if err := changeDuringBackgroundWork(ctx, narsil, oracle, variant, switchAnalysis); err != nil {
		t.Fatal(err)
	}
	if err := <-switched; err != nil {
		t.Fatalf("the analysis switch failed: %v", err)
	}
	if err := changeDuringBackgroundWork(ctx, narsil, oracle, variant, nil); err != nil {
		t.Fatal(err)
	}
	requireBorrowShelves(t, "right after writes that met merges, checkpoints, and a switch", narsil, oracle)
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if !variant.durable {
		return
	}
	reopened, err := openBorrowEngine(ctx, directory)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Shutdown(ctx) }()
	requireBorrowShelves(t, "after a restart", reopened, oracle)
}

func TestDeletesAndRepeatedUpdatesDuringMergesAndASwitchKeepEveryCountExact(t *testing.T) {
	t.Parallel()
	for _, variant := range []borrowVariant{
		{name: "merges without checkpoints", storage: engine.TextStorageMemory, batches: borrowSeedBatches},
		{name: "checkpoints with text in memory", storage: engine.TextStorageMemory, durable: true, batches: borrowSeedBatches},
		{name: "checkpoints with text on disk", storage: engine.TextStorageDisk, durable: true, batches: borrowDiskSeedBatches},
	} {
		t.Run(variant.name, func(t *testing.T) {
			t.Parallel()
			runBorrowedTokensAcrossMerges(t, variant)
		})
	}
}
