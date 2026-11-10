package partialwords

import (
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/highlight"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type HighlightMatcher struct {
	analyzer *analysis.Analyzer
	pass     *analysis.Pass
	words    []string
	lengths  []int
}

var _ highlight.PartialWordMatcher = (*HighlightMatcher)(nil)

func NewHighlightMatcher(analyzer *analysis.Analyzer, pass *analysis.Pass, words []string) *HighlightMatcher {
	lengths := make([]int, len(words))
	for at, word := range words {
		lengths[at] = text.UTF16Length(word)
	}
	return &HighlightMatcher{analyzer: analyzer, pass: pass, words: words, lengths: lengths}
}

func (m *HighlightMatcher) containsPartialWord(spelling string) bool {
	length := text.UTF16Length(spelling)
	for at, word := range m.words {
		if length > m.lengths[at] && strings.Contains(spelling, word) {
			return true
		}
	}
	return false
}

func (m *HighlightMatcher) MatcherFor(fieldText string) (func(position int, fieldToken string) bool, error) {
	positions := map[int]struct{}{}
	spellings := map[string]struct{}{}
	err := m.pass.Visit(fieldText, analysis.SurfaceOptions, func(token analysis.Token) {
		spelling := SpellingOf(token)
		if !m.containsPartialWord(spelling) {
			return
		}
		positions[token.Position] = struct{}{}
		spellings[spelling] = struct{}{}
	})
	if err != nil {
		return nil, err
	}
	if m.analyzer.HasCustomTokenizer() {
		return func(_ int, fieldToken string) bool {
			_, held := spellings[fieldToken]
			return held
		}, nil
	}
	return func(position int, _ string) bool {
		_, held := positions[position]
		return held
	}, nil
}
