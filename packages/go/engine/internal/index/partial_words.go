package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/highlight"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partialwords"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type partialWordOptions struct {
	fields       []string
	tolerance    int
	prefixLength int
}

func containsField(fields []string, wanted string) bool {
	for _, field := range fields {
		if field == wanted {
			return true
		}
	}
	return false
}

func (ix *Index) partialFieldsFor(query *model.QueryParams) []string {
	if !query.PartialWords || query.Exact {
		return nil
	}
	partial := ix.settings.Schema.PartialFields()
	if len(partial) == 0 || query.Fields == nil {
		return partial
	}
	for _, field := range query.Fields {
		if containsField(partial, field) {
			return partial
		}
	}
	return nil
}

func partialQueryTokens(tokens []partition.QueryToken) []partialwords.QueryToken {
	converted := make([]partialwords.QueryToken, len(tokens))
	for at, token := range tokens {
		converted[at] = partialwords.QueryToken{Token: token.Token, Position: token.Position}
	}
	return converted
}

func addPartialWordMembers(groups *[]partition.TermGroup, view partition.View, term *analysedTerm, written map[int]string, options partialWordOptions) {
	query := partialwords.Query{
		QueryTokens:  partialQueryTokens(term.unique),
		Written:      written,
		Tolerance:    options.tolerance,
		PrefixLength: model.Some(options.prefixLength),
	}
	if last, hasLast := term.lastToken(); hasLast {
		for _, group := range *groups {
			if group.Token == last.Token {
				query.PrefixToken = model.Some(last.Token)
			}
		}
	}
	for _, addition := range partialwords.ExpandQuery(query, view.ExpandPartialWords) {
		group := groupFor(groups, addition.Token, addition.TypoMatches)
		group.Members = partialwords.MergeAddedWords(group.Members, addition.Added)
	}
}

func (ix *Index) partialWordHighlighter(prepared *preparedQuery, pass *analysis.Pass) (highlight.PartialWordMatcher, []string, error) {
	params := &prepared.params
	term := prepared.term
	if !params.PartialWords || params.Exact || term == nil || len(term.tokens) == 0 {
		return nil, nil, nil
	}
	var fields []string
	for _, field := range ix.settings.Schema.PartialFields() {
		if params.Fields == nil || containsField(params.Fields, field) {
			fields = append(fields, field)
		}
	}
	if len(fields) == 0 {
		return nil, nil, nil
	}
	written, err := pass.Tokens(term.words, analysis.WrittenOptions)
	if err != nil {
		return nil, nil, err
	}
	queryTokens := make([]partialwords.QueryToken, len(term.tokens))
	for at, token := range term.tokens {
		queryTokens[at] = partialwords.QueryToken{Token: token.Term, Position: token.Position}
	}
	writtenTokens := make([]partialwords.QueryToken, len(written))
	for at, token := range written {
		writtenTokens[at] = partialwords.QueryToken{Token: token.Term, Position: token.Position}
	}
	words := partialwords.HighlightWords(queryTokens, writtenTokens)
	if len(words) == 0 {
		return nil, nil, nil
	}
	return partialwords.NewHighlightMatcher(ix.settings.Analyzer, pass, words), fields, nil
}
