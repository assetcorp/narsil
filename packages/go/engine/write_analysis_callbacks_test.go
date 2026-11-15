package engine_test

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

type countdownTokenizer struct {
	remaining atomic.Int32
	act       func()
}

func (c *countdownTokenizer) Tokenize(text string) []engine.Token {
	if c.remaining.Add(-1) == 0 {
		c.act()
	}
	words := strings.Fields(text)
	tokens := make([]engine.Token, len(words))
	for at, word := range words {
		tokens[at] = engine.Token{Token: strings.ToLower(word), Position: at}
	}
	return tokens
}

type analysedWrite struct {
	callsBeforeTheWrite int32
	write               func(narsil *engine.Narsil) error
}

func searchCount(narsil *engine.Narsil, ctx context.Context, term string) (int, error) {
	result, err := narsil.Query(ctx, callbackIndex, engine.QueryParams{Term: term})
	return result.Count, err
}

func TestAWriteTokenizerCanSearchItsIndex(t *testing.T) {
	writes := map[string]analysedWrite{
		"remove": {write: func(narsil *engine.Narsil) error {
			return narsil.Remove(context.Background(), callbackIndex, "kept", engine.WriteOptions{})
		}},
		"update": {callsBeforeTheWrite: 1, write: func(narsil *engine.Narsil) error {
			return narsil.Update(context.Background(), callbackIndex, "kept",
				engine.NewDocument().Set("title", "harbour"), engine.WriteOptions{})
		}},
	}
	for name, analysed := range writes {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			tokenizer := &countdownTokenizer{}
			narsil, err := engine.New(ctx, engine.Config{
				Tokenizers: map[string]engine.Tokenizer{"callback": tokenizer},
				Workers:    engine.WorkerConfig{Enabled: engine.Some(false)},
				Durability: &engine.DurabilityConfig{Directory: t.TempDir(), Mode: engine.DurabilitySync},
			})
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				bounded, cancel := context.WithTimeout(ctx, callbackDeadline)
				defer cancel()
				if err := narsil.Shutdown(bounded); err != nil {
					t.Errorf("the engine did not shut down after the %s: %v", name, err)
				}
			}()
			if err := narsil.CreateIndex(ctx, callbackIndex, engine.IndexConfig{
				Schema: engine.Schema{"title": engine.FieldString}, Tokenizer: engine.NamedTokenizer("callback"),
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := narsil.Insert(ctx, callbackIndex, engine.NewDocument().Set("title", "lighthouse"), "kept", engine.InsertOptions{}); err != nil {
				t.Fatal(err)
			}
			nested, nestedErr := -1, error(nil)
			tokenizer.act = func() {
				bounded, cancel := context.WithTimeout(ctx, callbackDeadline/2)
				defer cancel()
				nested, nestedErr = searchCount(narsil, bounded, "lighthouse")
			}
			tokenizer.remaining.Store(analysed.callsBeforeTheWrite + 1)
			if _, err := finishedWithin(t, name, func() (struct{}, error) { return struct{}{}, analysed.write(narsil) }); err != nil {
				t.Fatalf("the %s failed with %s: %v", name, codeOrMessage(err), err)
			}
			if nested != 1 || nestedErr != nil {
				t.Fatalf("the search inside the tokenizer found %d documents with error %v; the index held 1", nested, nestedErr)
			}
			if count, err := searchCount(narsil, ctx, "lighthouse"); count != 0 || err != nil {
				t.Fatalf("after the %s the old title still matches %d documents, %v", name, count, err)
			}
		})
	}
}
