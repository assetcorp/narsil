package engine_test

import (
	"context"
	"strings"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	largestTokenPosition      = 4_294_967_295
	tokenizerName             = "position-probe"
	wrappingPositionWord      = "wraps"
	negativePositionWord      = "backwards"
	largestPositionWord       = "furthest"
	positionProbeIndex        = "articles"
	positionProbeDocumentID   = "kept"
	positionProbeRefusedID    = "refused"
	positionProbeKeptTitle    = "harbour lighthouse"
	positionProbeKeptWord     = "lighthouse"
	positionProbeRefusedWords = "quarry"
)

type positionProbeTokenizer struct{}

func (positionProbeTokenizer) Tokenize(text string) []engine.Token {
	words := strings.Fields(strings.ToLower(text))
	tokens := make([]engine.Token, 0, len(words))
	for at, word := range words {
		position := at
		switch word {
		case wrappingPositionWord:
			position = largestTokenPosition + 1
		case negativePositionWord:
			position = -1
		case largestPositionWord:
			position = largestTokenPosition
		}
		tokens = append(tokens, engine.Token{Token: word, Position: position})
	}
	return tokens
}

func openPositionProbe(t *testing.T, ctx context.Context, directory string) *engine.Narsil {
	t.Helper()
	config := engine.Config{Tokenizers: map[string]engine.Tokenizer{tokenizerName: positionProbeTokenizer{}},
		Workers: engine.WorkerConfig{Enabled: engine.Some(false)}}
	if directory != "" {
		config.Durability = &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}
	}
	narsil, err := engine.New(ctx, config)
	if err != nil {
		t.Fatalf("open the engine: %v", err)
	}
	return narsil
}

func createPositionProbeIndex(t *testing.T, ctx context.Context, narsil *engine.Narsil) {
	t.Helper()
	err := narsil.CreateIndex(ctx, positionProbeIndex, engine.IndexConfig{
		Schema:    engine.Schema{"title": engine.FieldString},
		Tokenizer: engine.NamedTokenizer(tokenizerName),
	})
	if err != nil {
		t.Fatalf("create the index: %v", err)
	}
	if _, err := narsil.Insert(ctx, positionProbeIndex, engine.Document{"title": positionProbeKeptTitle},
		positionProbeDocumentID, engine.InsertOptions{}); err != nil {
		t.Fatalf("insert the kept document: %v", err)
	}
}

func requireCode(t *testing.T, err error, code string, what string) {
	t.Helper()
	if got := engine.ErrorCode(err); got != code {
		t.Fatalf("%s: got code %q (%v), want %q", what, got, err, code)
	}
}

func hitCount(t *testing.T, ctx context.Context, narsil *engine.Narsil, term string) int {
	t.Helper()
	result, err := narsil.Query(ctx, positionProbeIndex, engine.QueryParams{Term: term})
	if err != nil {
		t.Fatalf("query %q: %v", term, err)
	}
	return result.Count
}

func requireOnlyKeptDocument(t *testing.T, ctx context.Context, narsil *engine.Narsil) {
	t.Helper()
	count, err := narsil.CountDocuments(ctx, positionProbeIndex)
	if err != nil || count != 1 {
		t.Fatalf("document count: got %d (%v), want 1", count, err)
	}
	if held, err := narsil.Has(ctx, positionProbeIndex, positionProbeRefusedID); err != nil || held {
		t.Fatalf("the refused document is stored: held %v (%v)", held, err)
	}
	document, found, err := narsil.Get(ctx, positionProbeIndex, positionProbeDocumentID)
	if err != nil || !found || document["title"] != positionProbeKeptTitle {
		t.Fatalf("the kept document changed: %v, found %v (%v)", document, found, err)
	}
	if hits := hitCount(t, ctx, narsil, positionProbeRefusedWords); hits != 0 {
		t.Fatalf("a word of a refused document matches %d documents, want 0", hits)
	}
	if hits := hitCount(t, ctx, narsil, positionProbeKeptWord); hits != 1 {
		t.Fatalf("a word of the kept document matches %d documents, want 1", hits)
	}
}

func refusedTitles() []string {
	return []string{
		positionProbeRefusedWords + " " + wrappingPositionWord,
		negativePositionWord + " " + positionProbeRefusedWords,
	}
}

func exerciseRefusedWrites(t *testing.T, ctx context.Context, narsil *engine.Narsil) {
	t.Helper()
	for _, title := range refusedTitles() {
		_, err := narsil.Insert(ctx, positionProbeIndex, engine.Document{"title": title}, positionProbeRefusedID,
			engine.InsertOptions{})
		requireCode(t, err, engine.CodeDocValidationFailed, "insert "+title)
		err = narsil.Update(ctx, positionProbeIndex, positionProbeDocumentID, engine.Document{"title": title},
			engine.WriteOptions{})
		requireCode(t, err, engine.CodeDocValidationFailed, "update "+title)
		batch, err := narsil.InsertBatch(ctx, positionProbeIndex,
			[]engine.Document{{"id": positionProbeRefusedID, "title": title}}, engine.InsertOptions{})
		if err != nil || len(batch.Succeeded) != 0 || len(batch.Failed) != 1 {
			t.Fatalf("insert batch %q: %+v (%v)", title, batch, err)
		}
		requireCode(t, batch.Failed[0].Err, engine.CodeDocValidationFailed, "insert batch "+title)
		updates, err := narsil.UpdateBatch(ctx, positionProbeIndex,
			[]engine.DocumentUpdate{{DocID: positionProbeDocumentID, Document: engine.Document{"title": title}}},
			engine.WriteOptions{})
		if err != nil || len(updates.Succeeded) != 0 || len(updates.Failed) != 1 {
			t.Fatalf("update batch %q: %+v (%v)", title, updates, err)
		}
		requireCode(t, updates.Failed[0].Err, engine.CodeDocValidationFailed, "update batch "+title)
		_, err = narsil.Query(ctx, positionProbeIndex, engine.QueryParams{Term: title})
		requireCode(t, err, engine.CodeConfigInvalid, "query "+title)
		_, err = narsil.Preflight(ctx, positionProbeIndex, engine.QueryParams{Term: title})
		requireCode(t, err, engine.CodeConfigInvalid, "preflight "+title)
	}
}

func TestTokenizerPositionsOutsideTheStoredRangeAreRefused(t *testing.T) {
	ctx := context.Background()
	narsil := openPositionProbe(t, ctx, "")
	defer func() { _ = narsil.Shutdown(ctx) }()
	createPositionProbeIndex(t, ctx, narsil)
	exerciseRefusedWrites(t, ctx, narsil)
	requireOnlyKeptDocument(t, ctx, narsil)
	if _, err := narsil.Insert(ctx, positionProbeIndex, engine.Document{"title": "beacon " + largestPositionWord},
		"edge", engine.InsertOptions{}); err != nil {
		t.Fatalf("the largest stored position is refused: %v", err)
	}
	if hits := hitCount(t, ctx, narsil, largestPositionWord); hits != 1 {
		t.Fatalf("a word at the largest position matches %d documents, want 1", hits)
	}
}

func TestRefusedTokenizerPositionsLeaveNothingAfterARestart(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	narsil := openPositionProbe(t, ctx, directory)
	createPositionProbeIndex(t, ctx, narsil)
	exerciseRefusedWrites(t, ctx, narsil)
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("shut down: %v", err)
	}
	reopened := openPositionProbe(t, ctx, directory)
	defer func() { _ = reopened.Shutdown(ctx) }()
	requireOnlyKeptDocument(t, ctx, reopened)
}
