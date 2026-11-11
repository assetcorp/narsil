package query

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

const PartialWordExpansions = 50

type PartialWordRequest struct {
	Written      string
	Own          string
	Tolerance    uint32
	PrefixLength uint32
}

func (v *View) partialSources() []core.PartialWordSource {
	sources := make([]core.PartialWordSource, len(v.Segments))
	for index := range v.Segments {
		segment := &v.Segments[index]
		sources[index].Segment = segment.expansionSource()
		if segment.Growing == nil && segment.SpellingRuns != nil && len(segment.SpellingRuns.Offsets) > 0 {
			sources[index].Runs = segment.SpellingRuns
		}
	}
	return sources
}

func ExpandPartialWords(view *View, requests []PartialWordRequest) ([][]PrefixCompletion, error) {
	if err := validateExpansionView(view); err != nil {
		return nil, err
	}
	added := make([][]PrefixCompletion, len(requests))
	if len(requests) == 0 {
		return added, nil
	}
	request := &core.PartialWordsRequest{Sources: view.partialSources(), Words: make([]core.PartialWord, len(requests))}
	for at, word := range requests {
		request.Words[at] = core.PartialWord{
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
	if _, err := workspace.ExpandPartialWords(request, output); err != nil {
		return nil, expansionRefusal("partial-word", err)
	}
	for query := range requests {
		for at := output.Starts[query]; at < output.Starts[query+1]; at++ {
			segment, token := output.Additions.Segments[at], output.Additions.Tokens[at]
			if int(segment) >= len(view.Segments) || int(token) >= view.Segments[segment].termCount() {
				return nil, corruptExpansion("The partial-word addition refers to an invalid token")
			}
			added[query] = append(added[query], PrefixCompletion{Token: view.Segments[segment].termText(token), Factor: output.Additions.Factors[at]})
		}
	}
	return added, nil
}
