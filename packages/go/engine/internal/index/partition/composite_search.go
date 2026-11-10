package partition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type ordinalLayout struct {
	bases []uint32
	total uint32
}

func alignToWord(value uint32) uint32 {
	return (value + wordBits - 1) &^ (wordBits - 1)
}

func layoutOf(subs []keywordSource) ordinalLayout {
	layout := ordinalLayout{bases: make([]uint32, len(subs))}
	for at, sub := range subs {
		layout.bases[at] = layout.total
		layout.total += alignToWord(sub.ordinalCapacity())
	}
	return layout
}

func (l ordinalLayout) words(at int) (int, int) {
	start := int(l.bases[at] >> 5)
	end := int(l.total >> 5)
	if at+1 < len(l.bases) {
		end = int(l.bases[at+1] >> 5)
	}
	return start, end
}

func (l ordinalLayout) subBits(bits bitset.Bits, at int) bitset.Bits {
	start, end := l.words(at)
	start, end = min(start, len(bits)), min(end, len(bits))
	return bits[start:end:end]
}

func (l ordinalLayout) place(into bitset.Bits, at int, sub bitset.Bits) {
	start, end := l.words(at)
	if start >= len(into) {
		return
	}
	copy(into[start:min(end, len(into))], sub)
}

func (l ordinalLayout) locate(ordinal uint32) (int, uint32) {
	for at := len(l.bases) - 1; at >= 0; at-- {
		if ordinal >= l.bases[at] {
			return at, ordinal - l.bases[at]
		}
	}
	return 0, ordinal
}

func (s *side) subSources() []keywordSource {
	subs := make([]keywordSource, 0, len(s.frozen)+1)
	for _, sub := range s.frozen {
		subs = append(subs, sub)
	}
	return append(subs, s)
}

func onlyPopulatedSub(subs []keywordSource) int {
	found := -1
	for at, sub := range subs {
		if sub.documentCount() == 0 {
			continue
		}
		if found != -1 {
			return -1
		}
		found = at
	}
	return found
}

func subParams(params *SearchParams, layout ordinalLayout, at int, stats *GlobalStatistics) *SearchParams {
	scoped := *params
	scoped.GlobalStats = stats
	if params.HasFilter {
		scoped.Filter = layout.subBits(params.Filter, at)
	}
	return &scoped
}

func (r *SearchResult) shiftOrdinals(base uint32) {
	for at := range r.Scored {
		r.Scored[at].Ordinal += base
	}
}

func (s *side) searchComposite(params *SearchParams) (SearchResult, error) {
	if len(s.frozen) == 0 {
		return searcher{src: s}.searchFulltext(params)
	}
	if len(params.QueryTokens) == 0 && !params.HasPhrases {
		return SearchResult{}, nil
	}
	subs := s.subSources()
	layout := layoutOf(subs)
	words := bitset.WordsFor(int(layout.total))
	if single := onlyPopulatedSub(subs); single != -1 {
		result, err := searcher{src: subs[single]}.searchFulltext(subParams(params, layout, single, params.GlobalStats))
		if err != nil {
			return SearchResult{}, err
		}
		result.shiftOrdinals(layout.bases[single])
		if result.MatchedOrdinals != nil {
			placed := make(bitset.Bits, words)
			layout.place(placed, single, result.MatchedOrdinals)
			result.MatchedOrdinals = placed
		}
		return result, nil
	}
	stats := compositeQueryStats(subs, params)
	lists := make([][]ScoredDocument, len(subs))
	combined := SearchResult{}
	if params.CollectMatched == CollectMatchedOrdinals {
		combined.MatchedOrdinals = make(bitset.Bits, words)
	}
	for at, sub := range subs {
		result, err := searcher{src: sub}.searchFulltext(subParams(params, layout, at, stats))
		if err != nil {
			return SearchResult{}, err
		}
		result.shiftOrdinals(layout.bases[at])
		lists[at] = result.Scored
		combined.TotalMatched += result.TotalMatched
		if combined.MatchedOrdinals != nil && result.MatchedOrdinals != nil {
			layout.place(combined.MatchedOrdinals, at, result.MatchedOrdinals)
		}
		combined.MatchedIDs = append(combined.MatchedIDs, result.MatchedIDs...)
	}
	combined.Scored = mergeSortedScored(lists)
	if params.HasMaxResults && len(combined.Scored) > params.MaxResults {
		combined.Scored = combined.Scored[:max(0, params.MaxResults)]
	}
	return combined, nil
}

func mergeSortedScored(lists [][]ScoredDocument) []ScoredDocument {
	var merged []ScoredDocument
	for _, list := range lists {
		if len(list) == 0 {
			continue
		}
		if merged == nil {
			merged = list
			continue
		}
		next := make([]ScoredDocument, 0, len(merged)+len(list))
		left, right := 0, 0
		for left < len(merged) && right < len(list) {
			if merged[left].Score > list[right].Score ||
				merged[left].Score == list[right].Score && text.CompareCodePoints(merged[left].ID, list[right].ID) <= 0 {
				next = append(next, merged[left])
				left++
				continue
			}
			next = append(next, list[right])
			right++
		}
		next = append(next, merged[left:]...)
		merged = append(next, list[right:]...)
	}
	return merged
}

func typoTokensFor(src keywordSource, token string, group *TermGroup, params *SearchParams) []string {
	if group == nil {
		if !params.Exact {
			return src.fuzzyTokens(token, params.Tolerance, params.PrefixLength)
		}
		if src.holdsToken(token) {
			return []string{token}
		}
		return nil
	}
	if !group.TypoMatches || params.Exact || params.Tolerance == 0 {
		return nil
	}
	var kept []string
	for _, candidate := range src.fuzzyTokens(token, params.Tolerance, params.PrefixLength) {
		if candidate != token && !group.HoldsSynonym(candidate) {
			kept = append(kept, candidate)
		}
	}
	return kept
}

func collectCandidateTerms(subs []keywordSource, params *SearchParams) map[string]struct{} {
	terms := map[string]struct{}{}
	for _, phrase := range params.Phrases {
		for _, token := range phrase.Tokens {
			terms[token] = struct{}{}
		}
	}
	for _, queryToken := range params.QueryTokens {
		group := termGroupOf(params.TermGroups, queryToken.Token)
		if group != nil {
			for _, member := range group.Members {
				terms[member.Token] = struct{}{}
			}
			for _, synonym := range group.Synonyms {
				terms[synonym] = struct{}{}
			}
		}
		if group == nil && (params.Exact || params.Tolerance == 0) {
			terms[queryToken.Token] = struct{}{}
			continue
		}
		for _, sub := range subs {
			for _, token := range typoTokensFor(sub, queryToken.Token, group, params) {
				terms[token] = struct{}{}
			}
		}
	}
	return terms
}

func compositeQueryStats(subs []keywordSource, params *SearchParams) *GlobalStatistics {
	resolved := map[string]float64{}
	for term := range collectCandidateTerms(subs, params) {
		total := 0.0
		for _, sub := range subs {
			total += float64(sub.documentFrequency(term))
		}
		if total > 0 {
			resolved[term] = total
		}
	}
	caller := params.GlobalStats
	if caller == nil {
		totalDocuments, totals := aggregateFieldStats(subs)
		averages := map[string]float64{}
		if totalDocuments > 0 {
			for field, total := range totals {
				averages[field] = total / float64(totalDocuments)
			}
		}
		return &GlobalStatistics{TotalDocuments: float64(totalDocuments), AverageFieldLengths: averages, DocFrequencies: resolved}
	}
	for term, frequency := range caller.DocFrequencies {
		resolved[term] = frequency
	}
	return &GlobalStatistics{TotalDocuments: caller.TotalDocuments, AverageFieldLengths: caller.AverageFieldLengths, DocFrequencies: resolved}
}

func aggregateFieldStats(subs []keywordSource) (int, map[string]float64) {
	totalDocuments := 0
	totals := map[string]float64{}
	for _, sub := range subs {
		totalDocuments += sub.documentCount()
		for field, length := range sub.totalLengths() {
			totals[field] += length
		}
	}
	return totalDocuments, totals
}
