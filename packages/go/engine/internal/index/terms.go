package index

import (
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type queryPhrases struct {
	words             string
	phrases           []partition.Phrase
	keptPhraseCount   int
	largestPhraseSize int
	largestTokenCount int
	endsWithPhrase    bool
}

type analysedTerm struct {
	quoted     bool
	quotes     queryPhrases
	words      string
	tokens     []analysis.Token
	unique     []partition.QueryToken
	usesPrefix bool
}

func isQuoteCharacter(character rune) bool {
	return character == '"' || character == '“' || character == '”' || character == '„'
}

func holdsQuoteCharacter(term string) bool {
	return strings.IndexFunc(term, isQuoteCharacter) >= 0
}

func splitOnQuotes(term string) []string {
	var parts []string
	start := 0
	for at, character := range term {
		if isQuoteCharacter(character) {
			parts = append(parts, term[start:at])
			start = at + len(string(character))
		}
	}
	return append(parts, term[start:])
}

func isECMAScriptWhiteSpace(character rune) bool {
	return analysis.IsECMAScriptWhiteSpace(character)
}

func isBlank(value string) bool {
	return analysis.IsBlank(value)
}

func phraseKeyOf(tokens []string, offsets []int) string {
	var slots []string
	for index, token := range tokens {
		gap := 0
		if index > 0 {
			gap = offsets[index] - offsets[index-1] - 1
		}
		for missing := 0; missing < gap; missing++ {
			slots = append(slots, "?")
		}
		slots = append(slots, token)
	}
	return `"` + strings.Join(slots, " ") + `"`
}

func phraseIdentityOf(tokens []string, offsets []int) string {
	var identity strings.Builder
	for index, token := range tokens {
		identity.WriteString(strconv.Quote(token))
		identity.WriteByte(':')
		identity.WriteString(strconv.Itoa(offsets[index]))
		identity.WriteByte(',')
	}
	return identity.String()
}

func phraseSpanOf(first, last int) int {
	span := uint64(last) - uint64(first)
	if span >= math.MaxInt {
		return math.MaxInt
	}
	return int(span) + 1
}

func analyseQueryPhrases(parts []string, pass *analysis.Pass) (queryPhrases, error) {
	var analysed queryPhrases
	wordParts := make([]string, 0, len(parts)/2+1)
	seen := map[string]struct{}{}
	wordsAfterLastPhrase := ""
	for index, part := range parts {
		if index%2 == 0 {
			wordParts = append(wordParts, part)
			wordsAfterLastPhrase = wordsAfterLastPhrase + " " + part
			continue
		}
		if isBlank(part) {
			continue
		}
		entries, err := pass.Tokens(part, analysis.QueryOptions)
		if err != nil {
			return queryPhrases{}, err
		}
		if len(entries) == 0 {
			continue
		}
		sort.SliceStable(entries, func(left, right int) bool { return entries[left].Position < entries[right].Position })
		first := entries[0].Position
		size := phraseSpanOf(first, entries[len(entries)-1].Position)
		analysed.keptPhraseCount++
		wordsAfterLastPhrase = ""
		analysed.largestPhraseSize = max(analysed.largestPhraseSize, size)
		analysed.largestTokenCount = max(analysed.largestTokenCount, len(entries))
		if size > maxPhraseWords || len(entries) > maxPhraseWords {
			continue
		}
		tokens := make([]string, len(entries))
		offsets := make([]int, len(entries))
		for at, entry := range entries {
			tokens[at] = entry.Term
			offsets[at] = entry.Position - first
		}
		identity := phraseIdentityOf(tokens, offsets)
		if _, repeated := seen[identity]; repeated {
			continue
		}
		seen[identity] = struct{}{}
		analysed.phrases = append(analysed.phrases, partition.Phrase{Key: phraseKeyOf(tokens, offsets), Tokens: tokens, Offsets: offsets})
	}
	analysed.words = strings.Join(wordParts, " ")
	if analysed.keptPhraseCount > 0 {
		analysed.endsWithPhrase = isBlank(wordsAfterLastPhrase)
		if !analysed.endsWithPhrase {
			trailing, err := pass.Tokens(wordsAfterLastPhrase, analysis.QueryOptions)
			if err != nil {
				return queryPhrases{}, err
			}
			analysed.endsWithPhrase = len(trailing) == 0
		}
	}
	return analysed, nil
}

func requirePhrasesWithinLimits(phrases queryPhrases, trackPositions bool) error {
	if phrases.keptPhraseCount == 0 {
		return nil
	}
	if phrases.keptPhraseCount > maxQueryPhrases {
		return narsilerr.New(narsilerr.CodeSearchInvalidPhrase,
			"A query takes at most "+strconv.Itoa(maxQueryPhrases)+" phrases, while this query holds "+strconv.Itoa(phrases.keptPhraseCount),
			map[string]any{"limit": maxQueryPhrases, "phrases": phrases.keptPhraseCount})
	}
	if phrases.largestPhraseSize > maxPhraseWords || phrases.largestTokenCount > maxPhraseWords {
		words := max(phrases.largestPhraseSize, phrases.largestTokenCount)
		return narsilerr.New(narsilerr.CodeSearchInvalidPhrase,
			"A phrase takes at most "+strconv.Itoa(maxPhraseWords)+" words, counting the stop words between its first and last word, while this query holds one of "+strconv.Itoa(words),
			map[string]any{"limit": maxPhraseWords, "words": words})
	}
	if !trackPositions {
		return narsilerr.New(narsilerr.CodeSearchInvalidPhrase,
			"This index stores no word positions because its trackPositions setting is off, so it cannot match a phrase. Remove the quotes, or create the index with trackPositions on",
			map[string]any{"trackPositions": false})
	}
	return nil
}

func analyseTerm(term string, prefix bool, pass *analysis.Pass) (analysedTerm, error) {
	analysed := analysedTerm{words: term, usesPrefix: prefix}
	if holdsQuoteCharacter(term) {
		quotes, err := analyseQueryPhrases(splitOnQuotes(term), pass)
		if err != nil {
			return analysedTerm{}, err
		}
		analysed.quoted = true
		analysed.quotes = quotes
		analysed.words = quotes.words
		analysed.usesPrefix = prefix && !quotes.endsWithPhrase
	}
	if !analysed.quoted || !isBlank(analysed.words) {
		tokens, err := pass.Tokens(analysed.words, analysis.QueryOptions)
		if err != nil {
			return analysedTerm{}, err
		}
		analysed.tokens = tokens
	}
	seen := make(map[string]struct{}, len(analysed.tokens))
	for _, token := range analysed.tokens {
		if _, repeated := seen[token.Term]; repeated {
			continue
		}
		seen[token.Term] = struct{}{}
		analysed.unique = append(analysed.unique, partition.QueryToken{Token: token.Term, Position: token.Position})
	}
	return analysed, nil
}

func (a *analysedTerm) phrases() []partition.Phrase {
	if !a.quoted {
		return nil
	}
	return a.quotes.phrases
}

func (a *analysedTerm) lastToken() (partition.QueryToken, bool) {
	if len(a.tokens) == 0 {
		return partition.QueryToken{}, false
	}
	last := a.tokens[len(a.tokens)-1]
	return partition.QueryToken{Token: last.Term, Position: last.Position}, true
}

func uniqueTokenTerms(tokens []partition.QueryToken) []string {
	terms := make([]string, len(tokens))
	for index, token := range tokens {
		terms[index] = token.Token
	}
	return terms
}

func writtenWordsByPosition(words string, pass *analysis.Pass) (map[int]string, error) {
	unstemmed, err := pass.Tokens(words, analysis.WrittenOptions)
	if err != nil {
		return nil, err
	}
	written := make(map[int]string, len(unstemmed))
	for _, token := range unstemmed {
		if _, held := written[token.Position]; !held {
			written[token.Position] = token.Term
		}
	}
	return written, nil
}
