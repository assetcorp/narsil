package query

import (
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type FoldedWordRequest struct {
	Key          string
	Own          string
	Excluded     []string
	Tolerance    uint32
	PrefixLength uint32
}

type FoldedResult struct {
	Variants    []string
	TypoMatches []string
}

func (v *View) foldTables() ([]*core.FoldTable, error) {
	tables := make([]*core.FoldTable, len(v.Segments))
	for index := range v.Segments {
		if v.Segments[index].Folds == nil {
			return nil, corruptExpansion("A segment of the partition view holds no fold table")
		}
		tables[index] = v.Segments[index].Folds
	}
	return tables, nil
}

func foldedRefusal(operation string, err error) error {
	if errors.Is(err, core.ErrFoldTablesChanged) {
		return narsilerr.Wrap(narsilerr.CodePartitionCorrupted, "The fold tables of a partition kept changing while a search read them", err, nil)
	}
	return expansionRefusal(operation, err)
}

func (v *View) tokenAt(segment, token uint32) (string, error) {
	if int(segment) >= len(v.Segments) || int(token) >= v.Segments[segment].termCount() {
		return "", corruptExpansion("The folded expansion refers to an invalid token")
	}
	return v.Segments[segment].termText(token), nil
}

func (v *View) foldedBlock(output *core.FoldedTermsOutput, from, to, count uint32) ([]string, error) {
	var tokens []string
	for at := from; at < min(to, count); at++ {
		token, err := v.tokenAt(output.Segments[at], output.Tokens[at])
		if err != nil {
			return nil, err
		}
		tokens = append(tokens, token)
	}
	return tokens, nil
}

func foldedWordsOf(words []FoldedWordRequest) []core.FoldedWord {
	natives := make([]core.FoldedWord, len(words))
	for at, word := range words {
		natives[at] = core.FoldedWord{
			Key: unitsOf(word.Key), Own: unitsOf(word.Own), Excluded: unitsOfEach(word.Excluded),
			Tolerance: word.Tolerance, PrefixLength: word.PrefixLength,
		}
	}
	return natives
}

func ExpandFoldedTerms(view *View, language uint32, words []FoldedWordRequest) ([]FoldedResult, error) {
	if len(words) == 0 {
		return nil, nil
	}
	if err := validateExpansionView(view); err != nil {
		return nil, err
	}
	tables, err := view.foldTables()
	if err != nil {
		return nil, err
	}
	request := &core.FoldedTermsRequest{Segments: view.expansionSources(), Tables: tables, Language: language,
		Words: foldedWordsOf(words)}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer workspace.Release()
	output := &core.FoldedTermsOutput{Starts: make([]uint32, len(words)*foldedBlocksPerWord+1)}
	capacity := foldedTermsStartCapacity
	for range maxFoldedRoomAttempts {
		output.Segments, output.Tokens = make([]uint32, capacity), make([]uint32, capacity)
		count, err := workspace.ExpandFoldedTerms(request, output)
		if core.StatusOf(err) == core.StatusNeedsRoom {
			capacity *= 2
			continue
		}
		if err != nil {
			return nil, foldedRefusal("folded term", err)
		}
		found := make([]FoldedResult, len(words))
		for word := range words {
			at := word * foldedBlocksPerWord
			if found[word].Variants, err = view.foldedBlock(output, output.Starts[at], output.Starts[at+1], count); err != nil {
				return nil, err
			}
			if found[word].TypoMatches, err = view.foldedBlock(output, output.Starts[at+1], output.Starts[at+2], count); err != nil {
				return nil, err
			}
		}
		return found, nil
	}
	return nil, foldedRefusal("folded term", &core.StatusError{Operation: "expandFoldedTerms", Status: core.StatusNeedsRoom})
}

func ExpandFoldedPrefix(view *View, language uint32, typed, stemmed, folded string, limit int) ([]PrefixCompletion, error) {
	if err := validateExpansionView(view); err != nil {
		return nil, err
	}
	if limit <= 0 || typed == "" {
		return nil, nil
	}
	tables, err := view.foldTables()
	if err != nil {
		return nil, err
	}
	output := &core.ExpansionOutput{
		Segments: make([]uint32, PrefixExpansions), Tokens: make([]uint32, PrefixExpansions), Factors: make([]float64, PrefixExpansions),
	}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer workspace.Release()
	own := unitsOf(stemmed)
	request := &core.FoldedPrefixRequest{
		Prefix: core.PrefixExpansionRequest{Segments: view.expansionSources(), Typed: unitsOf(typed), Stemmed: own, Own: own},
		Tables: tables, Language: language, Folded: unitsOf(folded),
	}
	count, err := workspace.ExpandFoldedPrefix(request, output)
	if err != nil {
		return nil, foldedRefusal("folded keyword prefix", err)
	}
	completions := make([]PrefixCompletion, 0, min(int(count), limit))
	for at := range min(int(count), limit) {
		token, err := view.tokenAt(output.Segments[at], output.Tokens[at])
		if err != nil {
			return nil, err
		}
		completions = append(completions, PrefixCompletion{Token: token, Factor: output.Factors[at]})
	}
	return completions, nil
}

func ExpandFoldedPartialWords(view *View, language uint32, requests []PartialWordRequest, folded []string) ([][]PrefixCompletion, error) {
	if err := validateExpansionView(view); err != nil {
		return nil, err
	}
	added := make([][]PrefixCompletion, len(requests))
	if len(requests) == 0 {
		return added, nil
	}
	tables, err := view.foldTables()
	if err != nil {
		return nil, err
	}
	request := &core.FoldedPartialWordsRequest{
		Partial:  core.PartialWordsRequest{Sources: view.partialSources(), Words: make([]core.PartialWord, len(requests))},
		Tables:   tables,
		Language: language,
		Folded:   unitsOfEach(folded),
	}
	for at, word := range requests {
		request.Partial.Words[at] = core.PartialWord{
			Written: unitsOf(word.Written), Own: unitsOf(word.Own), Tolerance: word.Tolerance, PrefixLength: word.PrefixLength,
		}
	}
	output := &core.PartialWordsOutput{
		Additions: core.ExpansionOutput{
			Segments: make([]uint32, PartialWordExpansions), Tokens: make([]uint32, PartialWordExpansions),
			Factors: make([]float64, PartialWordExpansions),
		},
		Starts: make([]uint32, len(requests)+1),
	}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer workspace.Release()
	if _, err := workspace.ExpandFoldedPartialWords(request, output); err != nil {
		return nil, foldedRefusal("folded partial-word", err)
	}
	for query := range requests {
		for at := output.Starts[query]; at < output.Starts[query+1]; at++ {
			token, err := view.tokenAt(output.Additions.Segments[at], output.Additions.Tokens[at])
			if err != nil {
				return nil, err
			}
			added[query] = append(added[query], PrefixCompletion{Token: token, Factor: output.Additions.Factors[at]})
		}
	}
	return added, nil
}
