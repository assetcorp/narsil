package partition

import (
	"math"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type SuggestedSurface struct {
	Surface     string
	Occurrences int
}

type Suggestion struct {
	Token             string
	DocumentFrequency int
	Surfaces          []SuggestedSurface
}

func (s *side) verbatimOccurrences(token string) int {
	if !s.postings.Has(token) {
		return 0
	}
	derived := s.postings.TotalTermFrequency(token) - float64(s.surfaces.stemChangedTotalFor(token))
	if derived > 0 {
		return int(derived)
	}
	return 0
}

func (s *side) prefixSuggestions(prefix string) []postings.Suggestion {
	return s.postings.PrefixSearch(prefix, math.MaxInt)
}

func (s *side) surfaceCandidates(prefix string) []surfaceCandidate {
	return s.surfaces.candidatesForPrefix(prefix)
}

func (s *side) surfaceCount() int {
	return s.surfaces.size()
}

func suggestDisplayTerms(source keywordSource, surfacePrefix, stemmedPrefix string, limit int) []Suggestion {
	if limit <= 0 || surfacePrefix == "" {
		return nil
	}
	groups := map[string]*Suggestion{}
	var order []string
	groupOf := func(token string, documentFrequency int) (*Suggestion, bool) {
		if held := groups[token]; held != nil {
			return held, false
		}
		created := &Suggestion{Token: token, DocumentFrequency: documentFrequency}
		groups[token] = created
		order = append(order, token)
		return created, true
	}
	for _, candidate := range source.surfaceCandidates(surfacePrefix) {
		frequency := source.documentFrequency(candidate.token)
		if frequency == 0 {
			continue
		}
		group, _ := groupOf(candidate.token, int(frequency))
		group.Surfaces = append(group.Surfaces, SuggestedSurface{Surface: candidate.surface, Occurrences: candidate.occurrences})
	}
	prefixes := []string{surfacePrefix}
	if source.surfaceCount() == 0 && stemmedPrefix != surfacePrefix && stemmedPrefix != "" {
		prefixes = append(prefixes, stemmedPrefix)
	}
	for _, prefix := range prefixes {
		for _, suggestion := range source.prefixSuggestions(prefix) {
			occurrences := source.verbatimOccurrences(suggestion.Term)
			if occurrences == 0 {
				continue
			}
			group, created := groupOf(suggestion.Term, int(suggestion.DocumentFrequency))
			if !created && holdsSurface(group.Surfaces, suggestion.Term) {
				continue
			}
			group.Surfaces = append(group.Surfaces, SuggestedSurface{Surface: suggestion.Term, Occurrences: occurrences})
		}
	}
	results := make([]Suggestion, 0, len(order))
	for _, token := range order {
		results = append(results, *groups[token])
	}
	sortSuggestions(results)
	if len(results) > limit {
		results = results[:limit]
	}
	return results
}

func sortSuggestions(results []Suggestion) {
	sort.SliceStable(results, func(left, right int) bool {
		if results[left].DocumentFrequency != results[right].DocumentFrequency {
			return results[left].DocumentFrequency > results[right].DocumentFrequency
		}
		return text.CompareCodePoints(results[left].Token, results[right].Token) < 0
	})
}

func (v View) SuggestDisplayTerms(surfacePrefix, stemmedPrefix string, limit int) []Suggestion {
	sources := v.sources()
	if len(sources) == 1 {
		return suggestDisplayTerms(sources[0], surfacePrefix, stemmedPrefix, limit)
	}
	if limit <= 0 {
		return nil
	}
	type mergedTerm struct {
		frequency int
		surfaces  map[string]int
	}
	merged := map[string]*mergedTerm{}
	for _, source := range sources {
		for _, suggestion := range suggestDisplayTerms(source, surfacePrefix, stemmedPrefix, math.MaxInt) {
			entry := merged[suggestion.Token]
			if entry == nil {
				entry = &mergedTerm{surfaces: map[string]int{}}
				merged[suggestion.Token] = entry
			}
			entry.frequency += suggestion.DocumentFrequency
			for _, surface := range suggestion.Surfaces {
				entry.surfaces[surface.Surface] += surface.Occurrences
			}
		}
	}
	results := make([]Suggestion, 0, len(merged))
	for token, entry := range merged {
		suggestion := Suggestion{Token: token, DocumentFrequency: entry.frequency}
		for surface, occurrences := range entry.surfaces {
			suggestion.Surfaces = append(suggestion.Surfaces, SuggestedSurface{Surface: surface, Occurrences: occurrences})
		}
		sort.Slice(suggestion.Surfaces, func(left, right int) bool {
			a, b := suggestion.Surfaces[left], suggestion.Surfaces[right]
			if a.Occurrences != b.Occurrences {
				return a.Occurrences > b.Occurrences
			}
			return text.CompareCodePoints(a.Surface, b.Surface) < 0
		})
		results = append(results, suggestion)
	}
	sortSuggestions(results)
	if len(results) > limit {
		results = results[:limit]
	}
	return results
}

func holdsSurface(surfaces []SuggestedSurface, surface string) bool {
	for _, held := range surfaces {
		if held.Surface == surface {
			return true
		}
	}
	return false
}

func ExpandTermPrefix(views []View, surfacePrefix, stemmedToken string, maxExpansions int) []string {
	if maxExpansions <= 0 || surfacePrefix == "" {
		return nil
	}
	var sources []keywordSource
	for _, view := range views {
		sources = append(sources, view.sources()...)
	}
	holdsSurfaceForms := false
	for _, source := range sources {
		holdsSurfaceForms = holdsSurfaceForms || source.surfaceCount() > 0
	}
	prefixes := []string{surfacePrefix}
	if !holdsSurfaceForms && stemmedToken != surfacePrefix && stemmedToken != "" {
		prefixes = append(prefixes, stemmedToken)
	}
	candidates := map[string]struct{}{}
	for _, source := range sources {
		for _, candidate := range source.surfaceCandidates(surfacePrefix) {
			candidates[candidate.token] = struct{}{}
		}
		for _, prefix := range prefixes {
			for _, suggestion := range source.prefixSuggestions(prefix) {
				if _, held := candidates[suggestion.Term]; held {
					continue
				}
				if source.verbatimOccurrences(suggestion.Term) > 0 {
					candidates[suggestion.Term] = struct{}{}
				}
			}
		}
	}
	type ranked struct {
		token     string
		documents int
	}
	ranking := make([]ranked, 0, len(candidates))
	for token := range candidates {
		documents := 0
		for _, source := range sources {
			documents += int(source.documentFrequency(token))
		}
		if documents > 0 {
			ranking = append(ranking, ranked{token: token, documents: documents})
		}
	}
	sort.Slice(ranking, func(left, right int) bool {
		if ranking[left].documents != ranking[right].documents {
			return ranking[left].documents > ranking[right].documents
		}
		return text.CompareCodePoints(ranking[left].token, ranking[right].token) < 0
	})
	if len(ranking) > maxExpansions {
		ranking = ranking[:maxExpansions]
	}
	expansions := make([]string, len(ranking))
	for index, entry := range ranking {
		expansions[index] = entry.token
	}
	return expansions
}

func (v View) ExpandTermPrefix(surfacePrefix, stemmedToken string, maxExpansions int) []string {
	return ExpandTermPrefix([]View{v}, surfacePrefix, stemmedToken, maxExpansions)
}
