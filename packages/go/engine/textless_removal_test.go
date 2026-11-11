package engine_test

import (
	"context"
	"math"
	"strconv"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	textlessIndexName      = "ledger"
	textlessSearchedTitle  = "kettle"
	textlessSearchedID     = "titled-searched"
	textlessDocumentCount  = 6
	textlessScoreTolerance = 1e-6
	defaultSaturation      = 1.2
	defaultLengthWeight    = 0.75
)

var textlessOtherTitles = []string{"harbour", "lantern", "compass"}

func singleTokenScore(documents, matching int, averageLength float64) float64 {
	inverseFrequency := math.Log((float64(documents)-float64(matching)+0.5)/(float64(matching)+0.5) + 1)
	return inverseFrequency * (defaultSaturation + 1) /
		(1 + defaultSaturation*(1-defaultLengthWeight+defaultLengthWeight/averageLength))
}

func openTextlessLedger(t *testing.T, ctx context.Context, directory string) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)},
		Durability: &engine.DurabilityConfig{Directory: directory, Mode: engine.DurabilitySync}})
	if err != nil {
		t.Fatalf("open the engine: %v", err)
	}
	return narsil
}

func textlessID(at int) string {
	return "untitled-" + strconv.Itoa(at)
}

func insertLedger(t *testing.T, ctx context.Context, narsil *engine.Narsil) {
	t.Helper()
	insert := func(document *engine.Document, id string) {
		if _, err := narsil.Insert(ctx, textlessIndexName, document, id, engine.InsertOptions{}); err != nil {
			t.Fatalf("insert %s: %v", id, err)
		}
	}
	for at := range textlessDocumentCount {
		insert(engine.NewDocument().Set("rank", float64(at)), textlessID(at))
		if at == 0 {
			insert(engine.NewDocument().Set("title", textlessSearchedTitle), textlessSearchedID)
		}
		if at < len(textlessOtherTitles) {
			insert(engine.NewDocument().Set("title", textlessOtherTitles[at]), "titled-"+strconv.Itoa(at))
		}
	}
}

func requireSearchedScore(t *testing.T, ctx context.Context, narsil *engine.Narsil, want float64, when string) {
	t.Helper()
	result, err := narsil.Query(ctx, textlessIndexName, engine.QueryParams{Term: textlessSearchedTitle})
	if err != nil {
		t.Fatalf("search %s: %v", when, err)
	}
	if len(result.Hits) != 1 || result.Hits[0].ID != textlessSearchedID {
		t.Fatalf("the search %s returned %+v, want only %s", when, result.Hits, textlessSearchedID)
	}
	got, scored := result.Hits[0].Score.Get()
	if !scored || math.Abs(got-want) > textlessScoreTolerance*want {
		t.Fatalf("the score %s is %v (scored %v), want %v", when, got, scored, want)
	}
}

func TestRemovingDocumentsWithoutTextRestoresTheScoresOfTheRest(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	narsil := openTextlessLedger(t, ctx, directory)
	err := narsil.CreateIndex(ctx, textlessIndexName, engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString, "rank": engine.FieldNumber},
	})
	if err != nil {
		_ = narsil.Shutdown(ctx)
		t.Fatalf("create the index: %v", err)
	}
	insertLedger(t, ctx, narsil)
	titled := 1 + len(textlessOtherTitles)
	every := titled + textlessDocumentCount
	requireSearchedScore(t, ctx, narsil, singleTokenScore(every, 1, float64(titled)/float64(every)),
		"while the index holds documents without text")
	for at := range textlessDocumentCount {
		if err := narsil.Remove(ctx, textlessIndexName, textlessID(at), engine.WriteOptions{}); err != nil {
			_ = narsil.Shutdown(ctx)
			t.Fatalf("remove %s: %v", textlessID(at), err)
		}
	}
	requireSearchedScore(t, ctx, narsil, singleTokenScore(titled, 1, 1), "after the removal of every document without text")
	if err := narsil.Shutdown(ctx); err != nil {
		t.Fatalf("shut down: %v", err)
	}
	reopened := openTextlessLedger(t, ctx, directory)
	defer func() { _ = reopened.Shutdown(ctx) }()
	requireSearchedScore(t, ctx, reopened, singleTokenScore(titled, 1, 1), "after a restart")
}
