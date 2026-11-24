package engine_test

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	foldedCorpusSize         = 240
	foldedCorpusSeed         = 7
	foldedPartitions         = 3
	defaultFuzzyPrefixLength = 2
)

func pairedDocuments(pairs ...[2]string) []wordDocument {
	documents := make([]wordDocument, len(pairs))
	for at, pair := range pairs {
		documents[at] = wordDocument{id: pair[0], body: pair[1]}
	}
	return documents
}

func foldedEngine(t *testing.T, documents []wordDocument) *engine.Narsil {
	t.Helper()
	narsil := memoryEngine(t)
	config := textIndex("yoruba", bodySchema())
	config.Partitions = engine.PartitionConfig{MaxPartitions: engine.Some(foldedPartitions)}
	createIndex(t, narsil, "yoruba", config)
	insertWords(t, narsil, "yoruba", documents)
	if err := narsil.Rebalance(context.Background(), "yoruba", foldedPartitions); err != nil {
		t.Fatalf("the index did not spread over three partitions: %v", err)
	}
	plain := textIndex("yoruba", bodySchema())
	plain.FoldMarks = engine.Some(false)
	createIndex(t, narsil, "plain", plain)
	insertWords(t, narsil, "plain", documents)
	return narsil
}

func requireIDs(t *testing.T, label string, found []string, expected []string) {
	t.Helper()
	if !slices.Equal(found, expected) {
		t.Fatalf("%s matched %v, want %v", label, found, expected)
	}
}

func TestAQueryWithoutMarksFindsEveryFoldedSpelling(t *testing.T) {
	documents := generatedDocuments(foldedCorpusSize, yorubaWords, foldedCorpusSeed)
	narsil := foldedEngine(t, documents)
	for _, query := range yorubaQueryWords {
		expected := idsWithWord(documents, func(word string) bool { return yorubaFold(word) == query })
		if len(expected) == 0 {
			t.Fatalf("the corpus holds no %s", query)
		}
		requireIDs(t, query, foldHitIDs(t, narsil, "yoruba", termQuery(query)), expected)
	}
	for _, marked := range []string{"ọkọ̀", "ìlú", "ṣẹ́gun", "ọ̀rẹ́"} {
		expected := idsWithWord(documents, func(word string) bool { return yorubaFold(word) == yorubaFold(marked) })
		requireIDs(t, marked, foldHitIDs(t, narsil, "yoruba", termQuery(marked)), expected)
	}
	for _, query := range []string{"oko", "ọkọ", "ile"} {
		expected := idsWithWord(documents, func(word string) bool { return word == query })
		exact := termQuery(query)
		exact.Exact = true
		requireIDs(t, "exact "+query, foldHitIDs(t, narsil, "yoruba", exact), expected)
	}
	for _, query := range yorubaQueryWords {
		expected := idsWithWord(documents, func(word string) bool { return word == query })
		requireIDs(t, "unfolded "+query, foldHitIDs(t, narsil, "plain", termQuery(query)), expected)
	}
}

func TestATypoAndAHalfTypedWordReachMarkedSpellings(t *testing.T) {
	documents := generatedDocuments(foldedCorpusSize, yorubaWords, foldedCorpusSeed)
	narsil := foldedEngine(t, documents)
	for _, word := range yorubaQueryWords {
		query := word[:len(word)-1] + "x"
		accepts := func(candidate string) bool {
			return sharesLeadingPoints(candidate, query, defaultFuzzyPrefixLength) && editDistance(candidate, query) <= 1
		}
		expected := idsWithWord(documents, func(candidate string) bool {
			return accepts(candidate) || accepts(yorubaFold(candidate))
		})
		if len(expected) == 0 {
			t.Fatalf("the corpus holds no typo of %s", query)
		}
		typo := termQuery(query)
		typo.Tolerance = engine.Some(1)
		requireIDs(t, query, foldHitIDs(t, narsil, "yoruba", typo), expected)
	}
	for _, word := range yorubaQueryWords {
		typed := string([]rune(word)[:2])
		expected := idsWithWord(documents, func(candidate string) bool {
			return strings.HasPrefix(candidate, typed) || strings.HasPrefix(yorubaFold(candidate), typed)
		})
		prefix := termQuery(typed)
		prefix.Prefix = true
		requireIDs(t, typed, foldHitIDs(t, narsil, "yoruba", prefix), expected)
	}
}

func TestEveryQueryWordCoversItsTermThroughAMarkedSpelling(t *testing.T) {
	documents := generatedDocuments(foldedCorpusSize, yorubaWords, foldedCorpusSeed)
	narsil := foldedEngine(t, documents)
	holds := func(document wordDocument, query string) bool {
		return slices.ContainsFunc(strings.Split(document.body, " "), func(word string) bool { return yorubaFold(word) == query })
	}
	for _, pair := range [][2]string{{"oko", "ile"}, {"eja", "iwe"}, {"omo", "kekere"}} {
		var expected []string
		for _, document := range documents {
			if holds(document, pair[0]) && holds(document, pair[1]) {
				expected = append(expected, document.id)
			}
		}
		slices.Sort(expected)
		every := termQuery(pair[0] + " " + pair[1])
		every.TermMatch = engine.MatchAllTerms()
		requireIDs(t, pair[0]+" "+pair[1], foldHitIDs(t, narsil, "yoruba", every), expected)
	}
}

func TestTheWrittenSpellingRanksAboveAMarkedSpelling(t *testing.T) {
	narsil := memoryEngine(t)
	createIndex(t, narsil, "ranking", textIndex("yoruba", bodySchema()))
	insertWords(t, narsil, "ranking", pairedDocuments([2]string{"marked", "ọkọ kekere"}, [2]string{"plain", "oko kekere"}))
	requireIDs(t, "oko", rankedIDs(t, narsil, "ranking", termQuery("oko")), []string{"plain", "marked"})
	requireIDs(t, "ọkọ", rankedIDs(t, narsil, "ranking", termQuery("ọkọ")), []string{"marked", "plain"})
}

func TestAQuotedPhraseMatchesTheMarkedWordsOfADocument(t *testing.T) {
	narsil := memoryEngine(t)
	createIndex(t, narsil, "phrases", textIndex("yoruba", bodySchema()))
	insertWords(t, narsil, "phrases", pairedDocuments([2]string{"marked", "ọkọ̀ kékeré"}, [2]string{"plain", "oko kekere"},
		[2]string{"reversed", "kékeré ọkọ̀"}))
	requireIDs(t, "phrase", foldHitIDs(t, narsil, "phrases", termQuery(`"oko kekere"`)), []string{"marked", "plain"})
	exact := termQuery(`"oko kekere"`)
	exact.Exact = true
	requireIDs(t, "exact phrase", foldHitIDs(t, narsil, "phrases", exact), []string{"plain"})
}

func TestHausaFoldsItsHookedLettersAndFrenchFoldsBeforeItStems(t *testing.T) {
	narsil := memoryEngine(t)
	hausa := pairedDocuments([2]string{"hooked-room", "ɗaki"}, [2]string{"plain-room", "daki"},
		[2]string{"hooked-door", "ƙofa"}, [2]string{"plain-door", "kofa"}, [2]string{"hooked-rat", "ɓera"},
		[2]string{"plain-rat", "bera"})
	createIndex(t, narsil, "hausa", textIndex("hausa", bodySchema()))
	insertWords(t, narsil, "hausa", hausa)
	for _, query := range []string{"daki", "kofa", "bera"} {
		expected := idsWithWord(hausa, func(word string) bool { return foldOracle(word, hausaHookedLetters) == query })
		requireIDs(t, query, foldHitIDs(t, narsil, "hausa", termQuery(query)), expected)
	}
	createIndex(t, narsil, "french", textIndex("french", bodySchema()))
	insertWords(t, narsil, "french", pairedDocuments([2]string{"marked", "après la pluie"}, [2]string{"plain", "apres midi"}))
	requireIDs(t, "apres", rankedIDs(t, narsil, "french", termQuery("apres")), []string{"plain", "marked"})
	requireIDs(t, "après", rankedIDs(t, narsil, "french", termQuery("après")), []string{"marked", "plain"})
}

type scoredHit struct {
	id    string
	score float64
	set   bool
}

func scoredHits(t *testing.T, narsil *engine.Narsil, name string, params engine.QueryParams) []scoredHit {
	t.Helper()
	result, err := narsil.Query(context.Background(), name, params)
	if err != nil {
		t.Fatalf("the search of %q for %q failed: %v", name, params.Term, err)
	}
	hits := make([]scoredHit, len(result.Hits))
	for at, hit := range result.Hits {
		score, set := hit.Score.Get()
		hits[at] = scoredHit{id: hit.ID, score: score, set: set}
	}
	return hits
}

func TestAnEnglishIndexScoresAsAnIndexWithoutFolding(t *testing.T) {
	narsil := memoryEngine(t)
	english := pairedDocuments([2]string{"accented", "café latte naïve résumé"},
		[2]string{"plain", "cafe mocha naive resume"}, [2]string{"other", "coffee and tea"})
	createIndex(t, narsil, "default", textIndex("english", bodySchema()))
	unfolded := textIndex("english", bodySchema())
	unfolded.FoldMarks = engine.Some(false)
	createIndex(t, narsil, "unfolded", unfolded)
	insertWords(t, narsil, "default", english)
	insertWords(t, narsil, "unfolded", english)
	typo := termQuery("naive resume")
	typo.Tolerance = engine.Some(1)
	prefix := termQuery("caf")
	prefix.Prefix = true
	for _, params := range []engine.QueryParams{termQuery("cafe"), termQuery("café"), typo, prefix} {
		if found, plain := scoredHits(t, narsil, "default", params), scoredHits(t, narsil, "unfolded", params); !slices.Equal(found, plain) {
			t.Fatalf("%q scored %v with the default setting and %v without folding", params.Term, found, plain)
		}
	}
}
