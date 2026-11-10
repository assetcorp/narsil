package index

import (
	"sort"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/cursor"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type mergedSuggestion struct {
	token             string
	documentFrequency int
	surfaces          map[string]int
}

func trimECMAScript(value string) string {
	start, end := 0, len(value)
	for start < end {
		character, size := text.NextCodePoint(value, start)
		if !isECMAScriptWhiteSpace(character) {
			break
		}
		start += size
	}
	for end > start {
		at := end - 1
		for at > start && value[at]&0xC0 == 0x80 {
			at--
		}
		character, _ := text.NextCodePoint(value, at)
		if !isECMAScriptWhiteSpace(character) {
			break
		}
		end = at
	}
	return value[start:end]
}

func pickDisplaySurface(surfaces map[string]int) string {
	best, bestCount := "", -1
	for surface, occurrences := range surfaces {
		if occurrences > bestCount || occurrences == bestCount && text.CompareCodePoints(surface, best) < 0 {
			best, bestCount = surface, occurrences
		}
	}
	return best
}

func (ix *Index) suggestPrefixes(rawPrefix string, pass *analysis.Pass) (string, string, error) {
	var last string
	held := false
	err := pass.VisitWithCore(rawPrefix, analysis.Options{}, func(token analysis.Token) {
		last, held = token.Term, true
	})
	if err != nil {
		return "", "", err
	}
	rewriter, err := core.AcquireTokenRewriter()
	if err != nil {
		return "", "", err
	}
	defer rewriter.Release()
	if !held {
		lowered, err := rewriter.Lowercase(text.EncodeUTF16(rawPrefix))
		if err != nil {
			return "", "", err
		}
		last = text.DecodeUTF16(lowered)
	}
	if last == "" {
		return "", "", nil
	}
	stemmed, err := rewriter.Stem(ix.settings.Analyzer.Language(), text.EncodeUTF16(last))
	if err != nil {
		return "", "", err
	}
	return last, text.DecodeUTF16(stemmed), nil
}

func (ix *Index) Suggest(params model.SuggestParams) (model.SuggestResult, error) {
	started := time.Now()
	limit := max(1, min(cursor.ClampRowCount(params.Limit, defaultSuggestLimit), maxSuggestLimit))
	rawPrefix := trimECMAScript(params.Prefix)
	if rawPrefix == "" {
		return model.SuggestResult{Terms: []model.SuggestedTerm{}, Elapsed: time.Since(started)}, nil
	}
	last, stemmed, err := ix.suggestPrefixes(rawPrefix, ix.settings.Analyzer.PrepareWithoutStopWords())
	if err != nil {
		return model.SuggestResult{}, err
	}
	if last == "" {
		return model.SuggestResult{Terms: []model.SuggestedTerm{}, Elapsed: time.Since(started)}, nil
	}
	merged := map[string]*mergedSuggestion{}
	var order []*mergedSuggestion
	held := ix.acquireAll(ix.allPartitionIDs())
	for _, view := range held.partitions {
		for _, suggestion := range view.SuggestDisplayTerms(last, stemmed, limit*2) {
			entry := merged[suggestion.Token]
			if entry == nil {
				entry = &mergedSuggestion{token: suggestion.Token, surfaces: map[string]int{}}
				merged[suggestion.Token] = entry
				order = append(order, entry)
			}
			entry.documentFrequency += suggestion.DocumentFrequency
			for _, surface := range suggestion.Surfaces {
				entry.surfaces[surface.Surface] += surface.Occurrences
			}
		}
	}
	held.release()
	terms := make([]model.SuggestedTerm, len(order))
	for at, entry := range order {
		terms[at] = model.SuggestedTerm{Term: pickDisplaySurface(entry.surfaces), DocumentFrequency: entry.documentFrequency}
	}
	sort.SliceStable(terms, func(left, right int) bool {
		if terms[left].DocumentFrequency != terms[right].DocumentFrequency {
			return terms[left].DocumentFrequency > terms[right].DocumentFrequency
		}
		return text.CompareCodePoints(terms[left].Term, terms[right].Term) < 0
	})
	if len(terms) > limit {
		terms = terms[:limit]
	}
	return model.SuggestResult{Terms: terms, Elapsed: time.Since(started)}, nil
}
