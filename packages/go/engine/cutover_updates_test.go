package engine_test

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	cutoverIndex             = "ledger"
	cutoverDocuments         = 20_000
	cutoverSeedBatch         = 1_000
	cutoverUpdates           = 600
	cutoverUpdateInterval    = 2500 * time.Microsecond
	cutoverMostPartitions    = 4
	cutoverRebalanceTarget   = 2
	cutoverCheckedTerms      = 200
	cutoverHitLimit          = 1_000
	cutoverWordsPerBody      = 20
	cutoverDistinctWordStems = 50_000
)

type spaceTokenizer struct{}

func (spaceTokenizer) Tokenize(text string) []engine.Token {
	return tokensOf(strings.Fields(text))
}

type letterXTokenizer struct{}

func (letterXTokenizer) Tokenize(text string) []engine.Token {
	return tokensOf(letterXWords(text))
}

func letterXWords(text string) []string {
	return strings.FieldsFunc(text, func(r rune) bool { return r == ' ' || r == 'x' })
}

func tokensOf(words []string) []engine.Token {
	tokens := make([]engine.Token, len(words))
	for at, word := range words {
		tokens[at] = engine.Token{Token: word, Position: at}
	}
	return tokens
}

func cutoverBody(round int, at int) string {
	words := make([]string, cutoverWordsPerBody)
	for word := range words {
		words[word] = fmt.Sprintf("t%dx%d", (round*7+at*13+word*31)%cutoverDistinctWordStems, word%5)
	}
	return strings.Join(words, " ")
}

func cutoverID(at int) string {
	return fmt.Sprintf("d%07d", at)
}

func openCutoverEngine(t *testing.T, directory string) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Tokenizers: map[string]engine.Tokenizer{"space": spaceTokenizer{}, "letter-x": letterXTokenizer{}},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync,
			CheckpointInterval:          engine.Some(time.Duration(0)),
			CheckpointMutationThreshold: engine.Some(savedSizeDistantThreshold)}})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	return narsil
}

func updateWhile(t *testing.T, narsil *engine.Narsil, round int, expected map[string]string, cutover func() error,
	moment string) {
	t.Helper()
	ctx := context.Background()
	finished := make(chan error, 1)
	go func() { finished <- cutover() }()
	var mutex sync.Mutex
	var sent sync.WaitGroup
	failures := make(chan error, cutoverUpdates)
	ticker := time.NewTicker(cutoverUpdateInterval)
	defer ticker.Stop()
	for at := range cutoverUpdates {
		<-ticker.C
		id := cutoverID((round*cutoverUpdates + at) * 37 % cutoverDocuments)
		body := cutoverBody(round+1, at)
		sent.Add(1)
		go func() {
			defer sent.Done()
			if err := narsil.Update(ctx, cutoverIndex, id, engine.NewDocument().Set("body", body),
				engine.WriteOptions{}); err != nil {
				failures <- err
				return
			}
			mutex.Lock()
			defer mutex.Unlock()
			expected[id] = body
		}()
	}
	sent.Wait()
	close(failures)
	for err := range failures {
		t.Fatalf("an update during %s failed with %s: %v", moment, codeOrMessage(err), err)
	}
	if err := <-finished; err != nil {
		t.Fatalf("%s failed with %s: %v", moment, codeOrMessage(err), err)
	}
}

func expectedHitsOf(expected map[string]string, words func(string) []string, term string) []string {
	var ids []string
	for id, body := range expected {
		if slices.Contains(words(body), term) {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	return ids
}

func requireCutoverContents(t *testing.T, narsil *engine.Narsil, expected map[string]string,
	words func(string) []string, moment string) {
	t.Helper()
	ctx := context.Background()
	if count, err := narsil.CountDocuments(ctx, cutoverIndex); err != nil || count != len(expected) {
		t.Fatalf("%s, the index counts %d documents with %v, while it holds %d", moment, count, err, len(expected))
	}
	ids := make([]string, 0, len(expected))
	for id := range expected {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	read, err := narsil.GetMultiple(ctx, cutoverIndex, ids)
	if err != nil {
		t.Fatalf("%s, reading the documents failed with %s: %v", moment, codeOrMessage(err), err)
	}
	for _, id := range ids {
		document, found := read[id]
		if !found {
			t.Fatalf("%s, document %s is missing", moment, id)
		}
		if body, _ := document.Get("body"); body != expected[id] {
			t.Fatalf("%s, document %s reads %q, while it holds %q", moment, id, body, expected[id])
		}
	}
	for at := range cutoverCheckedTerms {
		var stems []string
		for _, word := range words(expected[ids[at*len(ids)/cutoverCheckedTerms]]) {
			if strings.HasPrefix(word, "t") {
				stems = append(stems, word)
			}
		}
		term := stems[at%len(stems)]
		result, err := narsil.Query(ctx, cutoverIndex,
			engine.QueryParams{Term: term, Limit: engine.Some(cutoverHitLimit)})
		if err != nil {
			t.Fatalf("%s, searching for %s failed with %s: %v", moment, term, codeOrMessage(err), err)
		}
		found := make([]string, 0, len(result.Hits))
		for _, hit := range result.Hits {
			found = append(found, hit.ID)
		}
		slices.Sort(found)
		if wanted := expectedHitsOf(expected, words, term); !slices.Equal(found, wanted) {
			t.Fatalf("%s, a search for %s finds %v, while the documents that hold it are %v", moment, term, found, wanted)
		}
	}
}

func TestUpdatesDuringAnAnalysisChangeAndARebalanceKeepEveryDocumentAndHitAcrossARestart(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	narsil := openCutoverEngine(t, directory)
	if err := narsil.CreateIndex(ctx, cutoverIndex, engine.IndexConfig{
		Schema: engine.Schema{"body": engine.FieldString}, Tokenizer: engine.NamedTokenizer("space"),
		Partitions: engine.PartitionConfig{MaxPartitions: engine.Some(cutoverMostPartitions)}}); err != nil {
		t.Fatalf("the engine refused the index with %s: %v", codeOrMessage(err), err)
	}
	expected := make(map[string]string, cutoverDocuments)
	for start := 0; start < cutoverDocuments; start += cutoverSeedBatch {
		batch := make([]*engine.Document, 0, cutoverSeedBatch)
		for at := start; at < start+cutoverSeedBatch; at++ {
			expected[cutoverID(at)] = cutoverBody(0, at)
			batch = append(batch, engine.DocumentFromMap(map[string]any{"id": cutoverID(at),
				"body": expected[cutoverID(at)]}))
		}
		insertEvery(t, narsil, cutoverIndex, batch)
	}
	checkpointOf(t, narsil, cutoverIndex)

	updateWhile(t, narsil, 0, expected, func() error {
		return narsil.ChangeAnalysis(ctx, cutoverIndex,
			engine.AnalysisChange{Tokenizer: engine.ChangeToRegisteredTokenizer("letter-x")})
	}, "the switch to letter-x")
	requireCutoverContents(t, narsil, expected, letterXWords, "after the switch")
	updateWhile(t, narsil, 1, expected, func() error {
		return narsil.Rebalance(ctx, cutoverIndex, cutoverRebalanceTarget)
	}, "the rebalance")
	requireCutoverContents(t, narsil, expected, letterXWords, "after the rebalance")

	shutDown(t, narsil, "right after the rebalance")
	narsil = openCutoverEngine(t, directory)
	requireCutoverContents(t, narsil, expected, letterXWords, "after the restart")
}
