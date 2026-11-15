package engine_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	cancellingTokenizerName = "cancels-the-search"
	cancellingIndex         = "articles"
	cancellingDocuments     = 50
	cancellingTerm          = "lighthouse"
	cancellingFarDeadline   = time.Minute
	cancellingNearDeadline  = 50 * time.Millisecond
)

type cancellingTokenizer struct {
	armed  atomic.Bool
	once   sync.Once
	during func()
}

func (c *cancellingTokenizer) Tokenize(text string) []engine.Token {
	if c.armed.Load() {
		c.once.Do(c.during)
	}
	words := strings.Fields(text)
	tokens := make([]engine.Token, 0, len(words))
	for at, word := range words {
		tokens = append(tokens, engine.Token{Token: strings.ToLower(word), Position: at})
	}
	return tokens
}

func openCancellingArticles(t *testing.T, tokenizer *cancellingTokenizer) *engine.Narsil {
	t.Helper()
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{
		Tokenizers: map[string]engine.Tokenizer{cancellingTokenizerName: tokenizer},
		Workers:    engine.WorkerConfig{Enabled: engine.Some(false)},
	})
	if err != nil {
		t.Fatalf("the engine refused to start with %s: %v", codeOrMessage(err), err)
	}
	t.Cleanup(func() { shutDown(t, narsil, "after the cancelled search") })
	config := engine.IndexConfig{Schema: engine.Schema{"title": engine.FieldString},
		Tokenizer: engine.NamedTokenizer(cancellingTokenizerName)}
	if err := narsil.CreateIndex(ctx, cancellingIndex, config); err != nil {
		t.Fatal(err)
	}
	documents := make([]*engine.Document, cancellingDocuments)
	for position := range documents {
		documents[position] = engine.NewDocument().Set("id", fmt.Sprintf("article-%d", position)).
			Set("title", fmt.Sprintf("%s keeper %d", cancellingTerm, position))
	}
	if result, err := narsil.InsertBatch(ctx, cancellingIndex, documents, engine.InsertOptions{}); err != nil || len(result.Failed) != 0 {
		t.Fatalf("inserting the articles failed: %v %+v", err, result.Failed)
	}
	return narsil
}

func TestASearchStopsWhenItsCallerCancelsDuringIt(t *testing.T) {
	cases := []struct {
		name     string
		deadline time.Duration
		during   func(ctx context.Context, cancel context.CancelFunc)
		expected error
	}{
		{name: "cancelled", deadline: cancellingFarDeadline, expected: context.Canceled,
			during: func(_ context.Context, cancel context.CancelFunc) { cancel() }},
		{name: "deadline", deadline: cancellingNearDeadline, expected: context.DeadlineExceeded,
			during: func(ctx context.Context, _ context.CancelFunc) { <-ctx.Done() }},
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			tokenizer := &cancellingTokenizer{}
			narsil := openCancellingArticles(t, tokenizer)
			bounded, cancel := context.WithTimeout(context.Background(), scenario.deadline)
			defer cancel()
			tokenizer.during = func() { scenario.during(bounded, cancel) }
			tokenizer.armed.Store(true)
			result, err := finishedWithin(t, "the search whose caller cancelled", func() (engine.QueryResult, error) {
				return narsil.Query(bounded, cancellingIndex, engine.QueryParams{Term: cancellingTerm})
			})
			if !errors.Is(err, scenario.expected) {
				t.Fatalf("the search returned %d hits and the error %v, expected %v", len(result.Hits), err, scenario.expected)
			}
		})
	}
}
