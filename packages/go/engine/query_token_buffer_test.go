package engine_test

import (
	"context"
	"strings"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

type reusableTokenBuffer struct {
	tokens []engine.Token
}

func (b *reusableTokenBuffer) Tokenize(text string) []engine.Token {
	b.tokens = b.tokens[:0]
	for at, word := range strings.Fields(text) {
		b.tokens = append(b.tokens, engine.Token{Token: word, Position: at})
	}
	return b.tokens
}

func TestPhraseSearchKeepsTokensFromAReusedCallerBuffer(t *testing.T) {
	ctx := context.Background()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Tokenizers: map[string]engine.Tokenizer{"reused": &reusableTokenBuffer{tokens: make([]engine.Token, 0, 16)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer shutDown(t, narsil, "after the phrase search")
	if err := narsil.CreateIndex(ctx, "colours", engine.IndexConfig{
		Schema:    engine.Schema{"title": engine.FieldString},
		Tokenizer: engine.NamedTokenizer("reused"),
	}); err != nil {
		t.Fatal(err)
	}
	for _, title := range []string{"red blue", "red red", "blue blue"} {
		if _, err := narsil.Insert(ctx, "colours", engine.NewDocument().Set("title", title), title, engine.InsertOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	result, err := narsil.Query(ctx, "colours", engine.QueryParams{Term: `"red" "blue"`})
	if err != nil || len(result.Hits) != 1 || result.Hits[0].ID != "red blue" {
		t.Fatalf("the two phrases returned %+v, %v; only red blue contains both", result.Hits, err)
	}
}
