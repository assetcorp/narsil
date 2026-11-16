package engine_test

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

type reentrantTokenizer struct {
	armed  atomic.Bool
	inside atomic.Int32
	acted  atomic.Int64
	act    func()
}

func (r *reentrantTokenizer) Tokenize(text string) []engine.Token {
	if r.armed.Load() && r.inside.CompareAndSwap(0, 1) {
		r.act()
		r.acted.Add(1)
		r.inside.Store(0)
	}
	return lowercaseWords(text)
}

func lowercaseWords(text string) []engine.Token {
	words := strings.Fields(text)
	tokens := make([]engine.Token, len(words))
	for at, word := range words {
		tokens[at] = engine.Token{Token: strings.ToLower(word), Position: at}
	}
	return tokens
}

type nestedErrors struct {
	mu   sync.Mutex
	errs []error
}

func (held *nestedErrors) note(err error) {
	if err == nil {
		return
	}
	held.mu.Lock()
	held.errs = append(held.errs, err)
	held.mu.Unlock()
}

func (held *nestedErrors) first() error {
	held.mu.Lock()
	defer held.mu.Unlock()
	if len(held.errs) == 0 {
		return nil
	}
	return held.errs[0]
}

func reentrantEngine(t *testing.T, tokenizer *reentrantTokenizer, storage engine.TextStorage,
	tokenized bool) *engine.Narsil {
	t.Helper()
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{
		Tokenizers: map[string]engine.Tokenizer{"callback": tokenizer},
		Workers:    engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { shutDownWithin(t, narsil, "after the test") })
	config := engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString}, TextStorage: storage}
	if tokenized {
		config.Tokenizer = engine.NamedTokenizer("callback")
	}
	if err := narsil.CreateIndex(ctx, callbackIndex, config); err != nil {
		t.Fatal(err)
	}
	return narsil
}

func uniqueTitle(id string) string {
	return "harbour q" + strings.ReplaceAll(id, "-", "x")
}

func requireFoundByTitle(t *testing.T, narsil *engine.Narsil, titles map[string]string) {
	t.Helper()
	for id, title := range titles {
		word := strings.Fields(title)[1]
		result, err := narsil.Query(context.Background(), callbackIndex, engine.QueryParams{Term: word})
		if err != nil || result.Count != 1 || len(result.Hits) != 1 || result.Hits[0].ID != id {
			t.Fatalf("a search for %q found %d documents, %v; the reference holds only %s", word, result.Count, err, id)
		}
	}
}

const checkpointsBesideUpdatesRounds = 20

func checkpointsBesideUpdates(narsil *engine.Narsil, titles map[string]string) error {
	ctx := context.Background()
	updated := make(chan error, 1)
	final := ""
	go func() {
		for round := range checkpointsBesideUpdatesRounds {
			final = uniqueTitle(fmt.Sprintf("round-%d", round))
			if err := narsil.Update(ctx, callbackIndex, "kept", engine.NewDocument().Set("title", final),
				engine.WriteOptions{}); err != nil {
				updated <- err
				return
			}
		}
		updated <- nil
	}()
	for range checkpointsBesideUpdatesRounds {
		if err := narsil.Checkpoint(ctx, callbackIndex); err != nil {
			<-updated
			return err
		}
	}
	if err := <-updated; err != nil {
		return err
	}
	titles["kept"] = final
	return narsil.Checkpoint(ctx, callbackIndex)
}

func TestATokenizerThatCallsCheckpointReturnsFromEveryWriteAndFromAdoption(t *testing.T) {
	writes := map[string]struct {
		storage engine.TextStorage
		run     func(narsil *engine.Narsil, titles map[string]string) error
	}{
		"insert": {engine.TextStorageMemory, func(narsil *engine.Narsil, titles map[string]string) error {
			titles["added"] = uniqueTitle("added")
			_, err := narsil.Insert(context.Background(), callbackIndex,
				engine.NewDocument().Set("title", titles["added"]), "added", engine.InsertOptions{})
			return err
		}},
		"update": {engine.TextStorageMemory, func(narsil *engine.Narsil, titles map[string]string) error {
			titles["kept"] = uniqueTitle("renamed")
			return narsil.Update(context.Background(), callbackIndex, "kept",
				engine.NewDocument().Set("title", titles["kept"]), engine.WriteOptions{})
		}},
		"remove": {engine.TextStorageMemory, func(narsil *engine.Narsil, titles map[string]string) error {
			delete(titles, "kept")
			return narsil.Remove(context.Background(), callbackIndex, "kept", engine.WriteOptions{})
		}},
		"checkpoints and adoption of text on disk beside updates": {engine.TextStorageDisk, checkpointsBesideUpdates},
	}
	for name, write := range writes {
		t.Run(name, func(t *testing.T) {
			tokenizer := &reentrantTokenizer{}
			narsil := reentrantEngine(t, tokenizer, write.storage, true)
			titles := map[string]string{"kept": uniqueTitle("kept"), "beside": uniqueTitle("beside")}
			for id, title := range titles {
				if _, err := narsil.Insert(context.Background(), callbackIndex, engine.NewDocument().Set("title", title), id,
					engine.InsertOptions{}); err != nil {
					t.Fatal(err)
				}
			}
			nested := &nestedErrors{}
			tokenizer.act = func() { nested.note(narsil.Checkpoint(context.Background(), callbackIndex)) }
			tokenizer.armed.Store(true)
			if _, err := finishedWithin(t, name, func() (struct{}, error) {
				return struct{}{}, write.run(narsil, titles)
			}); err != nil {
				t.Fatalf("the %s failed with %s: %v", name, codeOrMessage(err), err)
			}
			tokenizer.armed.Store(false)
			if tokenizer.acted.Load() == 0 {
				t.Fatalf("the tokenizer never ran inside the %s, so nothing called Checkpoint from it", name)
			}
			if err := nested.first(); err != nil {
				t.Fatalf("the Checkpoint inside the tokenizer failed with %s: %v", codeOrMessage(err), err)
			}
			requireFoundByTitle(t, narsil, titles)
		})
	}
}

func TestAWriteTokenizerReturnsBesideAQueuedDrop(t *testing.T) {
	tokenizer := &reentrantTokenizer{}
	narsil := reentrantEngine(t, tokenizer, engine.TextStorageMemory, true)
	ctx := context.Background()
	if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", uniqueTitle("kept")), "kept",
		engine.InsertOptions{}); err != nil {
		t.Fatal(err)
	}
	dropped := make(chan error, 1)
	nested := &nestedErrors{}
	tokenizer.act = func() {
		go func() { dropped <- narsil.DropIndex(ctx, callbackIndex) }()
		time.Sleep(100 * time.Millisecond)
		_, _, err := narsil.Get(ctx, callbackIndex, "kept")
		nested.note(err)
	}
	tokenizer.armed.Store(true)
	_, err := finishedWithin(t, "the insert beside a queued drop", func() (string, error) {
		return narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", uniqueTitle("added")), "added",
			engine.InsertOptions{})
	})
	if err != nil && engine.ErrorCode(err) != engine.CodeIndexNotFound {
		t.Fatalf("the insert beside a queued drop failed with %s: %v", codeOrMessage(err), err)
	}
	if err := nested.first(); err != nil && engine.ErrorCode(err) != engine.CodeIndexNotFound {
		t.Fatalf("the read inside the tokenizer failed with %s: %v", codeOrMessage(err), err)
	}
	select {
	case err := <-dropped:
		if err != nil {
			t.Fatalf("the drop failed with %s: %v", codeOrMessage(err), err)
		}
	case <-time.After(callbackDeadline):
		t.Fatalf("the drop did not return within %s", callbackDeadline)
	}
}

func TestATokenizerThatCallsTheEngineReturnsDuringAnAnalysisSwitch(t *testing.T) {
	tokenizer := &reentrantTokenizer{}
	narsil := reentrantEngine(t, tokenizer, engine.TextStorageMemory, false)
	ctx := context.Background()
	titles := map[string]string{}
	for at := range 300 {
		id := fmt.Sprintf("before-%d", at)
		titles[id] = uniqueTitle(id)
		if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", titles[id]), id,
			engine.InsertOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	var mu sync.Mutex
	nested := &nestedErrors{}
	var nestedInserts atomic.Int64
	tokenizer.act = func() {
		nested.note(narsil.Checkpoint(ctx, callbackIndex))
		id := fmt.Sprintf("nested-%d", nestedInserts.Add(1))
		title := uniqueTitle(id)
		if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", title), id,
			engine.InsertOptions{}); err != nil {
			nested.note(err)
		} else {
			mu.Lock()
			titles[id] = title
			mu.Unlock()
		}
		_, err := narsil.Query(ctx, callbackIndex, engine.QueryParams{Term: "harbour"})
		nested.note(err)
	}
	tokenizer.armed.Store(true)
	stopWriting := make(chan struct{})
	written := make(chan error, 1)
	go func() {
		for at := 0; ; at++ {
			select {
			case <-stopWriting:
				written <- nil
				return
			default:
			}
			id := fmt.Sprintf("during-%d", at)
			title := uniqueTitle(id)
			if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", title), id,
				engine.InsertOptions{}); err != nil {
				written <- err
				return
			}
			mu.Lock()
			titles[id] = title
			mu.Unlock()
		}
	}()
	_, err := finishedWithin(t, "the analysis change", func() (struct{}, error) {
		return struct{}{}, narsil.ChangeAnalysis(ctx, callbackIndex,
			engine.AnalysisChange{Tokenizer: engine.ChangeToRegisteredTokenizer("callback")})
	})
	close(stopWriting)
	if writeErr := <-written; writeErr != nil {
		t.Fatalf("a write during the switch failed with %s: %v", codeOrMessage(writeErr), writeErr)
	}
	tokenizer.armed.Store(false)
	if err != nil {
		t.Fatalf("the analysis change failed with %s: %v", codeOrMessage(err), err)
	}
	if tokenizer.acted.Load() == 0 {
		t.Fatal("the new tokenizer never ran during the switch")
	}
	if err := nested.first(); err != nil {
		t.Fatalf("a call inside the tokenizer failed with %s: %v", codeOrMessage(err), err)
	}
	requireFoundByTitle(t, narsil, titles)
}
