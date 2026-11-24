package engine_test

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"

	"golang.org/x/text/unicode/norm"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	firstCombiningMark  = '̀'
	lastCombiningMark   = 'ͯ'
	foldLCGMultiplier   = 1_103_515_245
	foldLCGIncrement    = 12_345
	foldLCGModulus      = 1 << 31
	foldLCGLowBits      = 1 << 16
	foldEveryHit        = 1_000
	foldIndexName       = "words"
	foldDocumentWordMin = 2
	foldDocumentWordGap = 3
)

var yorubaWords = []string{"ọkọ", "ọkọ̀", "oko", "okò", "ilé", "ile", "ìlú", "ilu", "ọmọ", "omo", "ẹja", "eja", "ọjà",
	"oja", "àgbà", "agba", "ṣẹ́gun", "segun", "kékeré", "kekere", "ọ̀rẹ́", "ore", "ìwé", "iwe"}

var yorubaQueryWords = []string{"oko", "ile", "ilu", "omo", "eja", "oja", "agba", "segun", "kekere", "ore", "iwe"}

var hausaHookedLetters = map[rune]rune{'ɓ': 'b', 'ɗ': 'd', 'ƙ': 'k', 'ƴ': 'y'}

type wordDocument struct {
	id   string
	body string
}

func foldOracle(word string, letters map[rune]rune) string {
	var folded strings.Builder
	for _, point := range norm.NFD.String(word) {
		if point >= firstCombiningMark && point <= lastCombiningMark {
			continue
		}
		if replaced, found := letters[point]; found {
			point = replaced
		}
		folded.WriteRune(point)
	}
	return folded.String()
}

func yorubaFold(word string) string {
	return foldOracle(word, nil)
}

func editDistance(left string, right string) int {
	a, b := []rune(left), []rune(right)
	previous := make([]int, len(b)+1)
	for column := range previous {
		previous[column] = column
	}
	for row := 1; row <= len(a); row++ {
		current := make([]int, len(b)+1)
		current[0] = row
		for column := 1; column <= len(b); column++ {
			substitution := previous[column-1]
			if a[row-1] != b[column-1] {
				substitution++
			}
			current[column] = min(previous[column]+1, current[column-1]+1, substitution)
		}
		previous = current
	}
	return previous[len(b)]
}

func sharesLeadingPoints(candidate string, query string, count int) bool {
	kept := []rune(query)
	kept = kept[:min(count, len(kept))]
	leading := []rune(candidate)
	return slices.Equal(leading[:min(len(kept), len(leading))], kept)
}

func idsWithWord(documents []wordDocument, matches func(word string) bool) []string {
	var ids []string
	for _, document := range documents {
		if slices.ContainsFunc(strings.Split(document.body, " "), matches) {
			ids = append(ids, document.id)
		}
	}
	slices.Sort(ids)
	return ids
}

func generatedDocuments(count int, words []string, seed uint64) []wordDocument {
	state := seed
	next := func() int {
		state = (state*foldLCGMultiplier + foldLCGIncrement) % foldLCGModulus
		return int(state / foldLCGLowBits)
	}
	documents := make([]wordDocument, count)
	for at := range documents {
		length := foldDocumentWordMin + next()%foldDocumentWordGap
		body := make([]string, length)
		for word := range body {
			body[word] = words[next()%len(words)]
		}
		documents[at] = wordDocument{id: fmt.Sprintf("doc-%05d", at), body: strings.Join(body, " ")}
	}
	return documents
}

func wordSpans(text string, matches func(word string) bool) []engine.HighlightPosition {
	spans := []engine.HighlightPosition{}
	start := 0
	for _, word := range strings.Split(text, " ") {
		length := len(utf16.Encode([]rune(word)))
		if matches(word) {
			spans = append(spans, engine.HighlightPosition{Start: start, End: start + length})
		}
		start += length + 1
	}
	return spans
}

func textIndex(language string, fields engine.Schema) engine.IndexConfig {
	return engine.IndexConfig{Schema: fields, Language: language}
}

func bodySchema() engine.Schema {
	return engine.Schema{"body": engine.FieldString}
}

func memoryEngine(t *testing.T) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(context.Background(), engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatalf("the engine refused to start: %v", err)
	}
	t.Cleanup(func() { _ = narsil.Shutdown(context.Background()) })
	return narsil
}

func createIndex(t *testing.T, narsil *engine.Narsil, name string, config engine.IndexConfig) {
	t.Helper()
	if err := narsil.CreateIndex(context.Background(), name, config); err != nil {
		t.Fatalf("index %q was refused: %v", name, err)
	}
}

func insertWords(t *testing.T, narsil *engine.Narsil, name string, documents []wordDocument) {
	t.Helper()
	batch := make([]*engine.Document, len(documents))
	for at, document := range documents {
		batch[at] = engine.NewDocument().Set("id", document.id).Set("body", document.body)
	}
	written, err := narsil.InsertBatch(context.Background(), name, batch, engine.InsertOptions{})
	if err != nil || len(written.Failed) > 0 {
		t.Fatalf("the batch into %q was refused: %v %v", name, err, written.Failed)
	}
}

func termQuery(term string) engine.QueryParams {
	return engine.QueryParams{Term: term, Limit: engine.Some(foldEveryHit)}
}

func rankedIDs(t *testing.T, narsil *engine.Narsil, name string, params engine.QueryParams) []string {
	t.Helper()
	result, err := narsil.Query(context.Background(), name, params)
	if err != nil {
		t.Fatalf("the search of %q for %q failed: %v", name, params.Term, err)
	}
	ids := make([]string, len(result.Hits))
	for at, hit := range result.Hits {
		ids[at] = hit.ID
	}
	return ids
}

func foldHitIDs(t *testing.T, narsil *engine.Narsil, name string, params engine.QueryParams) []string {
	t.Helper()
	ids := rankedIDs(t, narsil, name, params)
	slices.Sort(ids)
	if len(ids) == 0 {
		return nil
	}
	return ids
}

func highlightSpans(t *testing.T, narsil *engine.Narsil, name string, params engine.QueryParams, id string,
	field string) []engine.HighlightPosition {
	t.Helper()
	params.Highlight = &engine.HighlightConfig{Fields: []string{field}}
	result, err := narsil.Query(context.Background(), name, params)
	if err != nil {
		t.Fatalf("the search of %q for %q failed: %v", name, params.Term, err)
	}
	for _, hit := range result.Hits {
		if hit.ID != id {
			continue
		}
		found, marked := hit.Highlights[field]
		if !marked {
			return nil
		}
		return found.Positions
	}
	return nil
}
