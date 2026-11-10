package partition

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func (f *frozenSub) prefixSuggestions(prefix string) []postings.Suggestion {
	if prefix == "" {
		return nil
	}
	start, end := f.segment.PrefixRange(prefix)
	var results []postings.Suggestion
	for at := start; at < end; at++ {
		if documents := f.liveFrequencyAt(at); documents > 0 {
			results = append(results, postings.Suggestion{Term: f.segment.TokenAt(at), DocumentFrequency: documents})
		}
	}
	sort.Slice(results, func(left, right int) bool {
		if results[left].DocumentFrequency != results[right].DocumentFrequency {
			return results[left].DocumentFrequency > results[right].DocumentFrequency
		}
		return text.CompareCodePoints(results[left].Term, results[right].Term) < 0
	})
	return results
}

func (f *frozenSub) surfaceCandidates(prefix string) []surfaceCandidate {
	if prefix == "" {
		return nil
	}
	var candidates []surfaceCandidate
	for _, form := range f.segment.SurfacesWithPrefix(prefix) {
		occurrences := form.Occurrences - f.removedSurfaces[form.Surface]
		if occurrences > 0 {
			candidates = append(candidates, surfaceCandidate{surface: form.Surface, token: form.Token, occurrences: occurrences})
		}
	}
	return candidates
}

func (f *frozenSub) surfaceCount() int {
	return len(f.segment.Surfaces()) - f.vanishedSurfaces
}

func (f *frozenSub) totalTermFrequency(at int) float64 {
	total := f.segment.StoredTermFrequency(at)
	if f.removedOccurrences != nil {
		total -= f.removedOccurrences[at]
	}
	return total
}

func (f *frozenSub) verbatimOccurrences(token string) int {
	at, found := f.segment.FindToken(token)
	if !found || f.liveFrequencyAt(at) == 0 {
		return 0
	}
	derived := f.totalTermFrequency(at) - float64(f.segment.StemChangedTotal(token)-f.removedStemTotals[token])
	if derived > 0 {
		return int(derived)
	}
	return 0
}
