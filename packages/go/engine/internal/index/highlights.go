package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/highlight"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (ix *Index) highlightSource(prepared *preparedQuery) highlight.QuerySource {
	params := &prepared.params
	source := highlight.QuerySource{
		Words:        params.Term,
		Prefix:       params.Prefix,
		Exact:        params.Exact,
		Tolerance:    params.Tolerance,
		PrefixLength: params.PrefixLength,
		ExpandSynonyms: func(tokens []string) []string {
			expansion := ix.Synonyms().Expand(tokens)
			if expansion == nil {
				return nil
			}
			return expansion.Tokens
		},
	}
	if term := prepared.term; term != nil && term.quoted {
		source.Words = term.words
		source.Quoted = true
		source.Prefix = term.usesPrefix
		for _, phrase := range term.quotes.phrases {
			source.PhraseTokens = append(source.PhraseTokens, phrase.Tokens...)
		}
	}
	return source
}

func (ix *Index) applyHighlights(hits []model.Hit, documents *documentLookup, prepared *preparedQuery, pass *analysis.Pass) error {
	config := prepared.params.Highlight
	if config == nil {
		return nil
	}
	query, err := highlight.NewQuery(ix.settings.Analyzer, pass, ix.highlightSource(prepared))
	if err != nil {
		return err
	}
	readsStored := false
	for _, field := range config.Fields {
		readsStored = readsStored || !prepared.projection.KeepsField(field)
	}
	options := highlight.Options{PreTag: config.PreTag, PostTag: config.PostTag, MaxSnippetLength: config.MaxSnippetLength}
	partialMatcher, partialFields, err := ix.partialWordHighlighter(prepared, pass)
	if err != nil {
		return err
	}
	for at := range hits {
		marked := map[string]model.HighlightMatch{}
		var stored model.Document
		for _, field := range config.Fields {
			value, isText := hits[at].Document[field].(string)
			if !isText && readsStored {
				if stored == nil {
					if held := documents.stored(hits[at].ID); held != nil {
						stored = held.Fields
					}
				}
				value, isText = stored[field].(string)
			}
			if !isText {
				continue
			}
			fieldOptions := options
			if containsField(partialFields, field) {
				fieldOptions.PartialWords = partialMatcher
			}
			match, err := highlight.Field(value, query, fieldOptions)
			if err != nil {
				return err
			}
			marked[field] = match
		}
		hits[at].Highlights = marked
	}
	return nil
}
