package highlight

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type QuerySource struct {
	Words          string
	Quoted         bool
	PhraseTokens   []string
	Prefix         bool
	Exact          bool
	Tolerance      model.Optional[int]
	PrefixLength   model.Optional[int]
	ExpandSynonyms func(tokens []string) []string
}

type queryTerm struct {
	stem      []uint16
	tolerance int
}

type Query struct {
	pass         *analysis.Pass
	language     uint32
	terms        []queryTerm
	prefixToken  string
	hasPrefix    bool
	prefixLength int
	synonyms     map[string]struct{}
}

func NewQuery(analyzer *analysis.Analyzer, pass *analysis.Pass, source QuerySource) (*Query, error) {
	tokens, err := queryTokensOf(pass, source)
	if err != nil {
		return nil, err
	}
	query := &Query{
		pass:         pass,
		language:     analyzer.Language(),
		prefixLength: source.PrefixLength.Or(defaultFuzzyPrefixLength),
		synonyms:     map[string]struct{}{},
	}
	completedToken := ""
	if source.Prefix && !source.Exact && len(tokens) > 0 {
		written, err := pass.Tokens(source.Words, analysis.WrittenOptions)
		if err != nil {
			return nil, err
		}
		last := tokens[len(tokens)-1]
		for _, word := range written {
			if word.Position == last.Position {
				query.prefixToken = word.Term
				query.hasPrefix = true
				completedToken = last.Term
				break
			}
		}
	}
	tolerance := 0
	if !source.Exact {
		tolerance = source.Tolerance.Or(0)
	}
	if !source.Exact && len(tokens) > 0 && source.ExpandSynonyms != nil {
		terms := make([]string, len(tokens))
		for index, token := range tokens {
			terms[index] = token.Term
		}
		for _, synonym := range source.ExpandSynonyms(terms) {
			query.synonyms[unitKey(text.EncodeUTF16(synonym))] = struct{}{}
		}
	}
	for _, token := range source.PhraseTokens {
		query.synonyms[unitKey(text.EncodeUTF16(token))] = struct{}{}
	}
	if err := query.stemTerms(tokens, tolerance, completedToken); err != nil {
		return nil, err
	}
	return query, nil
}

func (q *Query) stemTerms(tokens []analysis.Token, tolerance int, completedToken string) error {
	if len(tokens) == 0 {
		return nil
	}
	rewriter, err := core.AcquireTokenRewriter()
	if err != nil {
		return err
	}
	defer rewriter.Release()
	q.terms = make([]queryTerm, len(tokens))
	for index, token := range tokens {
		lowered, err := rewriter.Lowercase(text.EncodeUTF16(token.Term))
		if err != nil {
			return err
		}
		stem, err := rewriter.Stem(q.language, lowered)
		if err != nil {
			return err
		}
		termTolerance := tolerance
		if q.hasPrefix && token.Term == completedToken {
			termTolerance = 0
		}
		q.terms[index] = queryTerm{stem: stem, tolerance: termTolerance}
	}
	return nil
}

func queryTokensOf(pass *analysis.Pass, source QuerySource) ([]analysis.Token, error) {
	if source.Quoted && isECMAScriptBlank(source.Words) {
		return nil, nil
	}
	return pass.Tokens(source.Words, analysis.QueryOptions)
}

func isECMAScriptBlank(words string) bool {
	for _, character := range words {
		if !isECMAScriptWhiteSpace(character) {
			return false
		}
	}
	return true
}

func isECMAScriptWhiteSpace(character rune) bool {
	switch character {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return character >= 0x2000 && character <= 0x200A
}

func (q *Query) isSynonym(stem []uint16) bool {
	if len(q.synonyms) == 0 {
		return false
	}
	_, found := q.synonyms[unitKey(stem)]
	return found
}

func (q *Query) matchesStem(stem []uint16) bool {
	if q.isSynonym(stem) {
		return true
	}
	for _, term := range q.terms {
		if fuzzyTermMatches(term.stem, stem, term.tolerance, q.prefixLength) {
			return true
		}
	}
	return false
}

func unitKey(units []uint16) string {
	key := make([]byte, 2*len(units))
	for index, unit := range units {
		key[2*index] = byte(unit >> 8)
		key[2*index+1] = byte(unit)
	}
	return string(key)
}
