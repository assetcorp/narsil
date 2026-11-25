package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
)

type highlightFoldingInputs struct {
	language     uint32
	queryTokens  []analysis.Token
	written      []analysis.Token
	phrases      []query.Phrase
	options      *query.HighlightOptions
	partialWords []string
}

func highlightFolding(inputs highlightFoldingInputs) (*query.FoldedHighlightOptions, []string, error) {
	analyser, err := core.AcquireAnalyser()
	if err != nil {
		return nil, nil, err
	}
	defer analyser.Release()
	writtenAt := make(map[int]string, len(inputs.written))
	for _, word := range inputs.written {
		if _, held := writtenAt[word.Position]; !held {
			writtenAt[word.Position] = word.Term
		}
	}
	folded := &query.FoldedHighlightOptions{}
	for _, token := range inputs.queryTokens {
		word, found := writtenAt[token.Position]
		if !found {
			word = token.Term
		}
		key, err := analyser.FoldSpelling(inputs.language, word, true)
		if err != nil {
			return nil, nil, err
		}
		tolerance := inputs.options.Tolerance
		if token.Term == inputs.options.CompletedToken {
			tolerance = 0
		}
		folded.Keys = append(folded.Keys, query.FoldedHighlightKey{Key: key, Tolerance: tolerance})
	}
	for _, phrase := range inputs.phrases {
		for at, token := range phrase.Tokens {
			word := token
			if at < len(phrase.Written) {
				word = phrase.Written[at]
			}
			key, err := analyser.FoldSpelling(inputs.language, word, true)
			if err != nil {
				return nil, nil, err
			}
			folded.Keys = append(folded.Keys, query.FoldedHighlightKey{Key: key})
		}
	}
	if inputs.options.HasPrefixToken {
		prefix, err := analyser.FoldSpelling(inputs.language, inputs.options.PrefixToken, false)
		if err != nil {
			return nil, nil, err
		}
		folded.Prefix, folded.HasPrefix = prefix, prefix != ""
	}
	var partialFolds []string
	for _, word := range inputs.partialWords {
		fold, err := analyser.FoldSpelling(inputs.language, word, false)
		if err != nil {
			return nil, nil, err
		}
		if fold != "" {
			partialFolds = append(partialFolds, fold)
		}
	}
	return folded, partialFolds, nil
}
