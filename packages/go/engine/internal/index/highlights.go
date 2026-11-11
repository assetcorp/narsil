package index

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type highlightPlan struct {
	tokens        []string
	options       query.HighlightOptions
	partialWords  []string
	partialFields []string
}

func highlightLength(value model.Optional[int]) uint32 {
	length := value.Or(query.DefaultMaxSnippetLength)
	return uint32(min(max(length, 0), math.MaxUint32))
}

func tokenTerms(tokens []analysis.Token) []string {
	terms := make([]string, len(tokens))
	for at, token := range tokens {
		terms[at] = token.Term
	}
	return terms
}

func (ix *Index) highlightPlanOf(prepared *preparedQuery, pass *analysis.Pass) (*highlightPlan, error) {
	params := &prepared.params
	config := params.Highlight
	words, prefix, quoted := params.Term, params.Prefix, false
	var phraseTokens []string
	if term := prepared.term; term != nil && term.quoted {
		words, prefix, quoted = term.words, term.usesPrefix, true
		for _, phrase := range term.quotes.phrases {
			phraseTokens = append(phraseTokens, phrase.Tokens...)
		}
	}
	var queryTokens []analysis.Token
	if !quoted || !isBlank(words) {
		tokens, err := pass.Tokens(words, analysis.QueryOptions)
		if err != nil {
			return nil, err
		}
		queryTokens = tokens
	}
	plan := &highlightPlan{tokens: tokenTerms(queryTokens), options: query.DefaultHighlightOptions(ix.settings.Analyzer.Language())}
	options := &plan.options
	options.PreTag = config.PreTag.Or(query.DefaultHighlightPreTag)
	options.PostTag = config.PostTag.Or(query.DefaultHighlightPostTag)
	options.MaxSnippetLength = highlightLength(config.MaxSnippetLength)
	options.PrefixLength = uint32(params.PrefixLength.Or(defaultFuzzyPrefixLength))
	if !params.Exact {
		options.Tolerance = uint32(params.Tolerance.Or(0))
	}
	usesPrefix := prefix && !params.Exact && len(queryTokens) > 0
	usesPartialWords := params.PartialWords && !params.Exact && len(queryTokens) > 0
	var written []analysis.Token
	if usesPrefix || usesPartialWords {
		tokens, err := pass.Tokens(words, analysis.WrittenOptions)
		if err != nil {
			return nil, err
		}
		written = tokens
	}
	if usesPrefix {
		last := queryTokens[len(queryTokens)-1]
		for _, word := range written {
			if word.Position == last.Position {
				options.PrefixToken, options.HasPrefixToken, options.CompletedToken = word.Term, true, last.Term
				break
			}
		}
	}
	if usesPartialWords {
		if fields := ix.partialHighlightFields(params); len(fields) > 0 {
			plan.partialWords, plan.partialFields = partialWordsToHighlight(queryTokens, written), fields
		}
	}
	if !params.Exact && len(queryTokens) > 0 {
		if expansion := ix.Synonyms().Expand(plan.tokens); expansion != nil {
			options.Synonyms = append(options.Synonyms, expansion.Tokens...)
		}
	}
	options.Synonyms = append(options.Synonyms, phraseTokens...)
	return plan, nil
}

func (plan *highlightPlan) field(field, value string) (model.HighlightMatch, error) {
	options := plan.options
	if len(plan.partialWords) > 0 && containsField(plan.partialFields, field) {
		options.PartialWords = plan.partialWords
	}
	match, err := query.Highlight(value, plan.tokens, options)
	if err != nil {
		return model.HighlightMatch{}, err
	}
	positions := make([]model.HighlightPosition, len(match.Positions))
	for at, span := range match.Positions {
		positions[at] = model.HighlightPosition{Start: span.Start, End: span.End}
	}
	return model.HighlightMatch{Snippet: match.Snippet, Positions: positions}, nil
}

func heldText(document *codec.Document, field string) (string, bool) {
	held, _ := codec.HeldValue(document, field)
	text, isText := held.(string)
	return text, isText
}

func (ix *Index) applyHighlights(hits []model.Hit, documents *documentLookup, prepared *preparedQuery, pass *analysis.Pass) error {
	config := prepared.params.Highlight
	if config == nil {
		return nil
	}
	plan, err := ix.highlightPlanOf(prepared, pass)
	if err != nil {
		return err
	}
	readsStored := false
	for _, field := range config.Fields {
		readsStored = readsStored || !prepared.projection.KeepsField(field)
	}
	for at := range hits {
		marked := map[string]model.HighlightMatch{}
		var stored *codec.Document
		for _, field := range config.Fields {
			value, isText := heldText(hits[at].Document, field)
			if !isText && readsStored {
				if stored == nil {
					stored = documents.shownAs(hits[at].ID, projection.Whole())
				}
				value, isText = heldText(stored, field)
			}
			if !isText {
				continue
			}
			match, err := plan.field(field, value)
			if err != nil {
				return err
			}
			marked[field] = match
		}
		hits[at].Highlights = marked
	}
	return documents.failure()
}
