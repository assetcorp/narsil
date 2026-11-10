package query

import (
	"math"
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	suggestionTermStride     = 3
	suggestionSpellingStride = 3
	frozenSurfaceStride      = 2
)

type SurfaceCount struct {
	Surface     string
	Occurrences float64
}

type Suggestion struct {
	Token             string
	DocumentFrequency int
	Surfaces          []SurfaceCount
}

type PrefixCompletion struct {
	Token  string
	Factor float64
}

func corruptExpansion(message string) error {
	return narsilerr.New(narsilerr.CodePartitionCorrupted, message, nil)
}

func expansionRefusal(operation string, err error) error {
	return narsilerr.Wrap(narsilerr.CodePartitionCorrupted, "The "+operation+" operation refused the partition view", err, nil)
}

func validateExpansionView(view *View) error {
	if err := validateView(view); err != nil {
		return err
	}
	for index := range view.Segments {
		if !view.Segments[index].pagedTotalsHeld() {
			return narsilerr.New(narsilerr.CodePartitionCorrupted, "A paged segment of the partition view needs one term total for every term",
				map[string]any{"segment": index})
		}
	}
	return nil
}

func (v *View) expansionSources() []core.ExpansionSegment {
	sources := make([]core.ExpansionSegment, len(v.Segments))
	for index := range v.Segments {
		sources[index] = v.Segments[index].expansionSource()
	}
	return sources
}

func (s *Segment) surfaceCount() int {
	if s.Growing != nil {
		if s.Growing.Surfaces == nil || len(s.Growing.Surfaces.Strings.Header) == 0 {
			return 0
		}
		return int(s.Growing.Surfaces.Strings.Header[0])
	}
	if s.Frozen.Surfaces == nil {
		return 0
	}
	return len(s.Frozen.Surfaces.Counts)
}

func (s *Segment) surfaceText(ordinal uint32) (string, bool) {
	if s.Growing != nil {
		if int(ordinal) >= s.surfaceCount() {
			return "", false
		}
		strings := &s.Growing.Surfaces.Strings
		if int(ordinal) >= len(strings.TermOffset) || int(ordinal) >= len(strings.TermLength) {
			return "", false
		}
		start := uint64(strings.TermOffset[ordinal])
		end := start + uint64(strings.TermLength[ordinal])
		if end > uint64(len(strings.Units)) {
			return "", false
		}
		return string(utf16.Decode(strings.Units[start:end])), true
	}
	table := s.Frozen.Surfaces
	at := uint64(ordinal) * frozenSurfaceStride
	if table == nil || at+1 >= uint64(len(table.Offsets)) {
		return "", false
	}
	start, end := table.Offsets[at], table.Offsets[at+1]
	if start >= end || int(end) > len(table.Text) {
		return "", false
	}
	return string(table.Text[start:end]), true
}

func (s *Segment) spellingText(kind, ordinal uint32) (string, bool) {
	if kind == core.SuggestionToken {
		if int(ordinal) >= s.termCount() {
			return "", false
		}
		return s.termText(ordinal), true
	}
	return s.surfaceText(ordinal)
}

func SuggestTerms(view *View, typed, stemmed string, limit int) ([]Suggestion, error) {
	if err := validateExpansionView(view); err != nil {
		return nil, err
	}
	if limit <= 0 || typed == "" {
		return nil, nil
	}
	termCapacity, spellingCapacity := 0, 0
	for index := range view.Segments {
		terms := view.Segments[index].termCount()
		termCapacity += terms
		spellingCapacity += terms + view.Segments[index].surfaceCount()
	}
	maximum := min(limit, math.MaxUint32)
	termCapacity = min(termCapacity, maximum)
	output := &core.SuggestionOutput{
		Terms: make([]uint32, termCapacity*suggestionTermStride), Starts: make([]uint32, termCapacity+1),
		Spellings: make([]uint32, spellingCapacity*suggestionSpellingStride), Occurrences: make([]float64, spellingCapacity),
	}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer workspace.Release()
	request := &core.SuggestionRequest{Segments: view.expansionSources(), Typed: unitsOf(typed), Stemmed: unitsOf(stemmed), Limit: uint32(maximum)}
	count, err := workspace.SuggestTerms(request, output)
	if err != nil {
		return nil, expansionRefusal("suggestion", err)
	}
	suggestions := make([]Suggestion, count)
	for at := range suggestions {
		row := output.Terms[at*suggestionTermStride : (at+1)*suggestionTermStride]
		if int(row[0]) >= len(view.Segments) || int(row[1]) >= view.Segments[row[0]].termCount() {
			return nil, corruptExpansion("The suggestion refers to an invalid token")
		}
		suggestions[at] = Suggestion{Token: view.Segments[row[0]].termText(row[1]), DocumentFrequency: int(row[2])}
		for next := output.Starts[at]; next < output.Starts[at+1]; next++ {
			spelling := output.Spellings[next*suggestionSpellingStride : (next+1)*suggestionSpellingStride]
			if int(spelling[0]) >= len(view.Segments) {
				return nil, corruptExpansion("The suggestion refers to an invalid spelling")
			}
			surface, valid := view.Segments[spelling[0]].spellingText(spelling[1], spelling[2])
			if !valid {
				return nil, corruptExpansion("The suggestion refers to an invalid spelling")
			}
			suggestions[at].Surfaces = append(suggestions[at].Surfaces, SurfaceCount{Surface: surface, Occurrences: output.Occurrences[next]})
		}
	}
	return suggestions, nil
}

func ExpandPrefix(view *View, typed, stemmed string, limit int) ([]PrefixCompletion, error) {
	if err := validateExpansionView(view); err != nil {
		return nil, err
	}
	if limit <= 0 || typed == "" {
		return nil, nil
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
	request := &core.PrefixExpansionRequest{Segments: view.expansionSources(), Typed: unitsOf(typed), Stemmed: own, Own: own}
	count, err := workspace.ExpandPrefix(request, output)
	if err != nil {
		return nil, expansionRefusal("keyword prefix", err)
	}
	completions := make([]PrefixCompletion, 0, min(int(count), limit))
	for at := range min(int(count), limit) {
		segment := output.Segments[at]
		if int(segment) >= len(view.Segments) || int(output.Tokens[at]) >= view.Segments[segment].termCount() {
			return nil, corruptExpansion("The keyword completion refers to an invalid token")
		}
		completions = append(completions, PrefixCompletion{Token: view.Segments[segment].termText(output.Tokens[at]), Factor: output.Factors[at]})
	}
	return completions, nil
}
