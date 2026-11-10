package query

import (
	"errors"
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	DefaultHighlightPreTag      = "<mark>"
	DefaultHighlightPostTag     = "</mark>"
	DefaultMaxSnippetLength     = 200
	firstHighlightSpans         = 16
	highlightSnippetExtraUnits  = 6
	highlightPositionsPerSpan   = 2
	highlightSpanGrowthFactor   = 2
	highlightUnitsPerSurrogates = 2
)

type HighlightOptions struct {
	Language         uint32
	PreTag           string
	PostTag          string
	MaxSnippetLength uint32
	PrefixToken      string
	HasPrefixToken   bool
	CompletedToken   string
	Tolerance        uint32
	PrefixLength     uint32
	Synonyms         []string
	PartialWords     []string
}

type HighlightSpan struct {
	Start int
	End   int
}

type HighlightMatch struct {
	Snippet   string
	Positions []HighlightSpan
}

func DefaultHighlightOptions(language uint32) HighlightOptions {
	return HighlightOptions{
		Language: language, PreTag: DefaultHighlightPreTag, PostTag: DefaultHighlightPostTag, MaxSnippetLength: DefaultMaxSnippetLength,
	}
}

func unitsOf(value string) []uint16 {
	return utf16.Encode([]rune(value))
}

func unitsOfEach(values []string) [][]uint16 {
	units := make([][]uint16, len(values))
	for at, value := range values {
		units[at] = unitsOf(value)
	}
	return units
}

func highlightQuery(tokens []string, options *HighlightOptions) core.HighlightQuery {
	query := core.HighlightQuery{
		Terms: make([]core.HighlightTerm, len(tokens)), PrefixLength: options.PrefixLength,
		Synonyms: unitsOfEach(options.Synonyms), PartialWords: unitsOfEach(options.PartialWords),
	}
	for at, token := range tokens {
		tolerance := options.Tolerance
		if token == options.CompletedToken {
			tolerance = 0
		}
		query.Terms[at] = core.HighlightTerm{Term: unitsOf(token), Tolerance: tolerance}
	}
	if options.HasPrefixToken {
		query.HasPrefix, query.Prefix = true, unitsOf(options.PrefixToken)
	}
	return query
}

func Highlight(text string, tokens []string, options HighlightOptions) (HighlightMatch, error) {
	if options.Language >= core.LanguageCount() {
		return HighlightMatch{}, narsilerr.New(narsilerr.CodeConfigInvalid, "The highlight names a language the core does not hold", nil)
	}
	analyser, err := core.AcquireAnalyser()
	if err != nil {
		return HighlightMatch{}, err
	}
	defer analyser.Release()
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return HighlightMatch{}, err
	}
	defer workspace.Release()
	request := &core.HighlightRequest{
		Language: options.Language, Text: unitsOf(text), Query: highlightQuery(tokens, &options),
		PreTag: unitsOf(options.PreTag), PostTag: unitsOf(options.PostTag), MaxSnippetLength: options.MaxSnippetLength,
	}
	length := len(request.Text)
	spans := min(length, firstHighlightSpans)
	for {
		output := &core.HighlightOutput{
			Snippet:   make([]uint16, length+highlightSnippetExtraUnits+spans*(len(request.PreTag)+len(request.PostTag))),
			Positions: make([]uint32, spans*highlightPositionsPerSpan),
		}
		outcome, err := workspace.Highlight(analyser, request, output)
		var status *core.StatusError
		if errors.As(err, &status) && status.Status == core.StatusNeedsRoom && spans < length {
			spans = min(length, spans*highlightSpanGrowthFactor)
			continue
		}
		if err != nil {
			return HighlightMatch{}, narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The field could not be highlighted", err, nil)
		}
		match := HighlightMatch{
			Snippet:   string(utf16.Decode(output.Snippet[:outcome.SnippetLength])),
			Positions: make([]HighlightSpan, outcome.Count),
		}
		for at := range match.Positions {
			match.Positions[at] = HighlightSpan{
				Start: int(output.Positions[at*highlightPositionsPerSpan]), End: int(output.Positions[at*highlightPositionsPerSpan+1]),
			}
		}
		return match, nil
	}
}
