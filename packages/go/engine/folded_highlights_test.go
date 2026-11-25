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
	highlightBody         = "ọkọ̀ kékeré ilé ọ̀rẹ́ ìwé"
	highlightName         = "ayọkẹlẹ ọkọ̀ ìwé"
	highlightPartialQuery = "oke"
)

func highlightSchema() engine.Schema {
	return engine.Schema{"body": engine.FieldString, "name": engine.FieldString.WithOptions(engine.TextFieldPartial)}
}

func highlightEngine(t *testing.T, config engine.IndexConfig) *engine.Narsil {
	t.Helper()
	narsil := memoryEngine(t)
	createIndex(t, narsil, foldIndexName, config)
	documents := []*engine.Document{
		engine.NewDocument().Set("id", "marked").Set("body", highlightBody).Set("name", highlightName),
		engine.NewDocument().Set("id", "other").Set("body", "eja oja").Set("name", "agba"),
	}
	written, err := narsil.InsertBatch(context.Background(), foldIndexName, documents, engine.InsertOptions{})
	if err != nil || len(written.Failed) > 0 {
		t.Fatalf("the batch was refused: %v %v", err, written.Failed)
	}
	return narsil
}

func markedSpans(t *testing.T, narsil *engine.Narsil, params engine.QueryParams, field string) []engine.HighlightPosition {
	t.Helper()
	return highlightSpans(t, narsil, foldIndexName, params, "marked", field)
}

func partialNameSpans() []engine.HighlightPosition {
	return wordSpans(highlightName, func(word string) bool {
		fold := yorubaFold(word)
		return utf8.RuneCountInString(fold) > len(highlightPartialQuery) && strings.Contains(fold, highlightPartialQuery)
	})
}

func requireSpans(t *testing.T, label string, found []engine.HighlightPosition, expected []engine.HighlightPosition) {
	t.Helper()
	if !slices.Equal(found, expected) {
		t.Fatalf("%s marked %v, want %v", label, found, expected)
	}
}

func TestAHighlightMarksEachMarkedWordThatAQueryWithoutMarksFinds(t *testing.T) {
	narsil := highlightEngine(t, textIndex("yoruba", highlightSchema()))
	queried := []string{"oko", "ile", "ore"}
	expected := wordSpans(highlightBody, func(word string) bool { return slices.Contains(queried, yorubaFold(word)) })
	if len(expected) != 3 {
		t.Fatalf("the body holds %d queried words, want 3", len(expected))
	}
	requireSpans(t, "oko ile ore", markedSpans(t, narsil, termQuery("oko ile ore"), "body"), expected)

	typo := "kekera"
	expected = wordSpans(highlightBody, func(word string) bool {
		fold := yorubaFold(word)
		return sharesLeadingPoints(fold, typo, defaultFuzzyPrefixLength) && editDistance(fold, typo) <= 1
	})
	if len(expected) != 1 {
		t.Fatalf("the body holds %d typos of %s, want 1", len(expected), typo)
	}
	params := termQuery(typo)
	params.Tolerance = engine.Some(1)
	requireSpans(t, typo, markedSpans(t, narsil, params, "body"), expected)

	expected = wordSpans(highlightBody, func(word string) bool { return strings.HasPrefix(yorubaFold(word), "ke") })
	params = termQuery("ke")
	params.Prefix = true
	requireSpans(t, "ke", markedSpans(t, narsil, params, "body"), expected)

	phrase := []string{"kekere", "ile"}
	expected = wordSpans(highlightBody, func(word string) bool { return slices.Contains(phrase, yorubaFold(word)) })
	requireSpans(t, "phrase", markedSpans(t, narsil, termQuery(`"kekere ile"`), "body"), expected)

	expected = partialNameSpans()
	if len(expected) != 1 {
		t.Fatalf("the name holds %d partial matches, want 1", len(expected))
	}
	params = termQuery(highlightPartialQuery)
	params.PartialWords = true
	requireSpans(t, "partial", markedSpans(t, narsil, params, "name"), expected)
}

func TestAnExactQueryMarksOnlyTheWrittenSpelling(t *testing.T) {
	narsil := highlightEngine(t, textIndex("yoruba", highlightSchema()))
	params := termQuery("oko")
	params.Exact = true
	if found := rankedIDs(t, narsil, foldIndexName, params); len(found) != 0 {
		t.Fatalf("an exact query matched a fold: %v", found)
	}
	params = termQuery("ọkọ̀")
	params.Exact = true
	requireSpans(t, "exact", markedSpans(t, narsil, params, "body"),
		wordSpans(highlightBody, func(word string) bool { return word == "ọkọ̀" }))
}

func TestAnIndexWithItsOwnStopWordsMarksAFoldedPartialWord(t *testing.T) {
	config := textIndex("yoruba", highlightSchema())
	config.StopWords = engine.StopWordList("ati")
	narsil := highlightEngine(t, config)
	params := termQuery(highlightPartialQuery)
	params.PartialWords = true
	requireSpans(t, "partial", markedSpans(t, narsil, params, "name"), partialNameSpans())
	params = termQuery("oko ile")
	params.PartialWords = true
	requireSpans(t, "oko ile", markedSpans(t, narsil, params, "name"),
		wordSpans(highlightName, func(word string) bool { return yorubaFold(word) == "oko" }))
}
