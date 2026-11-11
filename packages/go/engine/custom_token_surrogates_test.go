package engine_test

import (
	"context"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	halfCharacterTokenizer = "drops-the-last-byte"
	halfCharacterIndex     = "notes"
)

type lastByteDroppingTokenizer struct{}

func (lastByteDroppingTokenizer) Tokenize(text string) []engine.Token {
	words := strings.Fields(text)
	tokens := make([]engine.Token, 0, len(words))
	for at, word := range words {
		tokens = append(tokens, engine.Token{Token: word[:len(word)-1], Position: at})
	}
	return tokens
}

const replacementCharacter = string(utf8.RuneError)

var halfCharacterDocuments = map[string]string{
	"smile":    "a\U0001F600",
	"replaced": "a" + replacementCharacter + "x",
	"plain":    "ab",
}

var halfCharacterExpectedHits = map[string][]string{
	"a\U0001F600":                    {"replaced", "smile"},
	"a\U0001F642":                    {"replaced", "smile"},
	"a" + replacementCharacter + "z": {"replaced", "smile"},
	"ab":                             {"plain"},
}

func openHalfCharacterEngine(t *testing.T, ctx context.Context, directory string) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(ctx, engine.Config{
		Tokenizers: map[string]engine.Tokenizer{halfCharacterTokenizer: lastByteDroppingTokenizer{}},
		Workers:    engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync},
	})
	if err != nil {
		t.Fatalf("open the engine: %v", err)
	}
	return narsil
}

func requireHalfCharacterHits(t *testing.T, ctx context.Context, narsil *engine.Narsil, stage string) {
	t.Helper()
	for term, expected := range halfCharacterExpectedHits {
		result, err := narsil.Query(ctx, halfCharacterIndex, engine.QueryParams{Term: term})
		if err != nil {
			t.Fatalf("%s: query %q: %v", stage, term, err)
		}
		ids := make([]string, 0, len(result.Hits))
		for _, hit := range result.Hits {
			ids = append(ids, hit.ID)
		}
		slices.Sort(ids)
		if !slices.Equal(ids, expected) {
			t.Fatalf("%s: query %q found %q, want %q", stage, term, ids, expected)
		}
	}
}

func TestATokenCutThroughACharacterFindsTheSameDocumentsBeforeAndAfterAFreeze(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	narsil := openHalfCharacterEngine(t, ctx, directory)
	err := narsil.CreateIndex(ctx, halfCharacterIndex, engine.IndexConfig{
		Schema:    engine.Schema{"title": engine.FieldString},
		Tokenizer: engine.NamedTokenizer(halfCharacterTokenizer),
	})
	if err != nil {
		t.Fatalf("create the index: %v", err)
	}
	for id, title := range halfCharacterDocuments {
		if _, err := narsil.Insert(ctx, halfCharacterIndex, engine.NewDocument().Set("title", title), id,
			engine.InsertOptions{}); err != nil {
			t.Fatalf("insert %s: %v", id, err)
		}
	}
	_, err = narsil.Insert(ctx, halfCharacterIndex, engine.NewDocument().Set("title", "a\xed\xa0\x80"), "lone",
		engine.InsertOptions{})
	requireCode(t, err, engine.CodeDocValidationFailed, "insert a title that holds a lone surrogate")

	requireHalfCharacterHits(t, ctx, narsil, "growing")
	if err := narsil.Checkpoint(ctx, halfCharacterIndex); err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	requireHalfCharacterHits(t, ctx, narsil, "frozen")
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("shut down: %v", err)
	}

	reopened := openHalfCharacterEngine(t, ctx, directory)
	defer func() { _ = reopened.Shutdown(ctx) }()
	requireHalfCharacterHits(t, ctx, reopened, "reopened")
	if held, err := reopened.Has(ctx, halfCharacterIndex, "lone"); err != nil || held {
		t.Fatalf("the refused document is stored: held %v (%v)", held, err)
	}
}
