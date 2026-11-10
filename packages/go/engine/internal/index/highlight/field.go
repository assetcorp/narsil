package highlight

import (
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type PartialWordMatcher interface {
	MatcherFor(fieldText string) (func(position int, fieldToken string) bool, error)
}

type Options struct {
	PreTag           model.Optional[string]
	PostTag          model.Optional[string]
	MaxSnippetLength model.Optional[int]
	PartialWords     PartialWordMatcher
}

type fieldMatcher struct {
	query    *Query
	rewriter *core.TokenRewriter
	known    map[string]bool
}

func (m *fieldMatcher) matches(fieldToken string) (bool, error) {
	if known, found := m.known[fieldToken]; found {
		return known, nil
	}
	stem, err := m.rewriter.Stem(m.query.language, text.EncodeUTF16(fieldToken))
	if err != nil {
		return false, err
	}
	matched := m.query.matchesStem(stem)
	m.known[fieldToken] = matched
	return matched, nil
}

func unmarked(source string) model.HighlightMatch {
	return model.HighlightMatch{Snippet: source, Positions: []model.HighlightPosition{}}
}

func Field(source string, query *Query, options Options) (model.HighlightMatch, error) {
	preTag := text.EncodeUTF16(options.PreTag.Or(defaultPreTag))
	postTag := text.EncodeUTF16(options.PostTag.Or(defaultPostTag))
	maxSnippetLength := options.MaxSnippetLength.Or(defaultMaxSnippetLength)
	units := text.EncodeUTF16(source)
	if len(units) == 0 {
		return unmarked(source), nil
	}
	var tokens []analysis.Token
	err := query.pass.VisitWithCore(source, analysis.Options{}, func(token analysis.Token) { tokens = append(tokens, token) })
	if err != nil {
		return model.HighlightMatch{}, err
	}
	if len(tokens) == 0 {
		return unmarked(source), nil
	}
	rewriter, err := core.AcquireTokenRewriter()
	if err != nil {
		return model.HighlightMatch{}, err
	}
	defer rewriter.Release()
	ranges, err := matchedRanges(source, units, tokens, query, rewriter, options.PartialWords)
	if err != nil {
		return model.HighlightMatch{}, err
	}
	merged := mergeOverlapping(ranges)
	truncates := maxSnippetLength > 0 && len(units) > maxSnippetLength
	if len(merged) == 0 {
		if truncates {
			return model.HighlightMatch{Snippet: text.DecodeUTF16(units[:maxSnippetLength]) + ellipsis, Positions: []model.HighlightPosition{}}, nil
		}
		return unmarked(source), nil
	}
	if truncates {
		snippet, visible := truncatedSnippet(units, merged, maxSnippetLength, preTag, postTag)
		return model.HighlightMatch{Snippet: text.DecodeUTF16(snippet), Positions: positionsOf(visible)}, nil
	}
	return model.HighlightMatch{Snippet: text.DecodeUTF16(insertTags(units, merged, preTag, postTag)), Positions: positionsOf(merged)}, nil
}

func matchedRanges(source string, units []uint16, tokens []analysis.Token, query *Query, rewriter *core.TokenRewriter, partialWords PartialWordMatcher) ([]span, error) {
	lowered, err := rewriter.LowercaseNFC(units)
	if err != nil {
		return nil, err
	}
	offsets := tokenOffsets(text.DecodeUTF16(lowered), tokens)
	var matchesInside func(position int, fieldToken string) bool
	if partialWords != nil {
		matchesInside, err = partialWords.MatcherFor(source)
		if err != nil {
			return nil, err
		}
	}
	matcher := fieldMatcher{query: query, rewriter: rewriter, known: map[string]bool{}}
	var ranges []span
	for index, token := range tokens {
		if index >= len(offsets) {
			break
		}
		fieldToken := token.Term
		prefixMatch := query.hasPrefix && strings.HasPrefix(fieldToken, query.prefixToken)
		insideMatch := matchesInside != nil && matchesInside(token.Position, fieldToken)
		matched := prefixMatch || insideMatch
		if !matched {
			matched, err = matcher.matches(fieldToken)
			if err != nil {
				return nil, err
			}
		}
		if matched {
			ranges = append(ranges, offsets[index])
		}
	}
	return ranges, nil
}

func tokenOffsets(lowered string, tokens []analysis.Token) []span {
	offsets := make([]span, 0, len(tokens))
	missing := map[string]struct{}{}
	searchByte, searchUnit := 0, 0
	for _, token := range tokens {
		original := token.Original
		if _, missed := missing[original]; missed {
			continue
		}
		found := strings.Index(lowered[searchByte:], original)
		if found < 0 {
			missing[original] = struct{}{}
			continue
		}
		startByte := searchByte + found
		start := searchUnit + text.UTF16Length(lowered[searchByte:startByte])
		end := start + text.UTF16Length(original)
		offsets = append(offsets, span{start: start, end: end})
		searchByte = startByte + len(original)
		searchUnit = end
	}
	return offsets
}

func positionsOf(spans []span) []model.HighlightPosition {
	positions := make([]model.HighlightPosition, len(spans))
	for index, marked := range spans {
		positions[index] = model.HighlightPosition{Start: marked.start, End: marked.end}
	}
	return positions
}
