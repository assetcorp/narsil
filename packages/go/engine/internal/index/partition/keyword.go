package partition

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func (s searcher) frequencyOf(params *SearchParams, token string, list *postings.List) float64 {
	if params.GlobalStats != nil {
		if frequency, found := params.GlobalStats.DocFrequencies[token]; found {
			return frequency
		}
	}
	if list != nil {
		return float64(list.DocumentFrequency)
	}
	return float64(s.src.documentFrequency(token))
}

func typoMatchesFor(src keywordSource, token string, group *TermGroup, params *SearchParams) ([]postings.Match, error) {
	if group != nil {
		if !group.TypoMatches || params.Exact || params.Tolerance == 0 {
			return nil, nil
		}
		found, err := src.fuzzy(token, params.Tolerance, params.PrefixLength)
		if err != nil {
			return nil, err
		}
		kept := found[:0]
		for _, match := range found {
			if match.Token != token && !group.HoldsSynonym(match.Token) {
				kept = append(kept, match)
			}
		}
		sortMatches(kept)
		return kept, nil
	}
	if !params.Exact {
		found, err := src.fuzzy(token, params.Tolerance, params.PrefixLength)
		if err != nil {
			return nil, err
		}
		sortMatches(found)
		return found, nil
	}
	list, found, err := src.lookup(token)
	if err != nil || !found {
		return nil, err
	}
	return []postings.Match{{Token: token, List: list}}, nil
}

func sortMatches(matches []postings.Match) {
	sort.SliceStable(matches, func(left, right int) bool {
		return text.CompareCodePoints(matches[left].Token, matches[right].Token) < 0
	})
}

func (s searcher) planGroup(builder *requestBuilder, params *SearchParams, group *TermGroup, term int) error {
	documentFrequency := 0.0
	if group.HasSynonyms {
		for _, synonym := range group.Synonyms {
			documentFrequency = max(documentFrequency, s.frequencyOf(params, synonym, nil))
		}
	}
	type plannedMember struct {
		member GroupMember
		list   postings.List
		rows   rowColumns
		pooled bool
	}
	members := make([]plannedMember, 0, len(group.Members))
	for _, member := range group.Members {
		documentFrequency = max(documentFrequency, s.frequencyOf(params, member.Token, nil))
		if group.HasSynonyms && member.Token == group.Token {
			list, rows, pooled, found, err := s.combinedPostings(member.Token, group.Synonyms)
			if err != nil {
				return err
			}
			if found {
				members = append(members, plannedMember{member: member, list: list, rows: rows, pooled: pooled})
			}
			continue
		}
		list, found, err := s.src.lookup(member.Token)
		if err != nil {
			return err
		}
		if found {
			members = append(members, plannedMember{member: member, list: list, pooled: true})
		}
	}
	builder.groupSlot(term, documentFrequency)
	for _, planned := range members {
		if planned.pooled {
			builder.poolList(planned.list, planned.member.Factor, planned.member.PartialFactor, planned.member.Token)
			continue
		}
		builder.rowList(planned.rows, false, planned.member.Factor, planned.member.PartialFactor, planned.member.Token)
	}
	return nil
}

func (s searcher) planKeywordSlots(builder *requestBuilder, params *SearchParams, phrases *phraseMatches) error {
	for term, queryToken := range params.QueryTokens {
		group := termGroupOf(params.TermGroups, queryToken.Token)
		matches, err := typoMatchesFor(s.src, queryToken.Token, group, params)
		if err != nil {
			return err
		}
		builder.termSlot(term)
		for index := range matches {
			match := &matches[index]
			builder.poolList(match.List, s.frequencyOf(params, match.Token, &match.List), 0, match.Token)
		}
		if group != nil {
			if err := s.planGroup(builder, params, group, term); err != nil {
				return err
			}
		}
	}
	if phrases == nil {
		return nil
	}
	for _, rows := range phrases.rows {
		frequencies := make([]float64, len(rows.phrase.Tokens))
		for at, token := range rows.phrase.Tokens {
			list := rows.lists[at]
			frequencies[at] = s.frequencyOf(params, token, &list)
		}
		builder.phraseSlot(frequencies, rows.columns, rows.phrase.Key)
	}
	return nil
}

func (s searcher) searchFulltext(params *SearchParams) (SearchResult, error) {
	if len(params.QueryTokens) == 0 && !params.HasPhrases {
		return SearchResult{}, nil
	}
	builder := acquireBuilder(s.src.pool())
	defer builder.release()
	s.loadKeywordFields(builder, params)
	var phrases *phraseMatches
	filter, hasFilter := params.Filter, params.HasFilter
	if params.HasPhrases {
		matched, err := s.matchPhrases(params.Phrases, builder.request.Searchable, params, true)
		if err != nil {
			return SearchResult{}, err
		}
		if matched.matched.IsEmpty() {
			return SearchResult{}, nil
		}
		phrases = matched
		filter, hasFilter = matched.matched, true
	}
	if err := s.planKeywordSlots(builder, params, phrases); err != nil {
		return SearchResult{}, err
	}
	capacity := s.src.ordinalCapacity()
	request := &builder.request
	request.HasFilter, request.Filter = hasFilter, filter
	request.Live = s.src.liveBits()
	request.Removed = s.src.removedBits()
	request.Terms = float64(len(params.QueryTokens))
	request.Capacity = capacity
	request.TotalDocuments = s.totalDocumentsFor(params)
	request.Limit = core.KeywordNoLimit
	if params.HasMaxResults {
		request.Limit = float64(max(0, params.MaxResults))
	}
	request.Collect = params.CollectMatched != CollectNoMatches
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return SearchResult{}, err
	}
	defer workspace.Release()
	output := builder.sizeOutput(capacity)
	outcome, err := workspace.KeywordScore(request, output)
	if err != nil {
		return SearchResult{}, err
	}
	return s.resultOf(builder, params, outcome)
}

func (s searcher) resultOf(builder *requestBuilder, params *SearchParams, outcome core.KeywordOutcome) (SearchResult, error) {
	output := &builder.output
	count := min(int(outcome.Count), len(output.Ordinals))
	var components map[uint32]*componentRecord
	if params.CollectComponents {
		components = keywordComponents(builder, s.src.names(), output.Ordinals[:count])
	}
	page := make([]ScoredDocument, 0, count)
	for at := 0; at < count; at++ {
		ordinal := uint32(output.Ordinals[at])
		id, live := s.src.idAt(ordinal)
		if !live {
			continue
		}
		scored := ScoredDocument{ID: id, Ordinal: ordinal, Score: output.Scores[at], Document: s.src.heldDocument(ordinal)}
		if components != nil {
			scored.Components = components[ordinal].public()
		}
		page = append(page, scored)
	}
	sort.Slice(page, func(left, right int) bool { return scoredBefore(page[left], page[right]) })
	if params.HasMaxResults && len(page) > params.MaxResults {
		page = page[:max(0, params.MaxResults)]
	}
	result := SearchResult{Scored: page, TotalMatched: int(outcome.TotalMatched)}
	words := (int(s.src.ordinalCapacity()) + 31) >> 5
	switch params.CollectMatched {
	case CollectMatchedOrdinals:
		result.MatchedOrdinals = append(bitset.Bits(nil), output.Matched[:max(1, words)]...)
	case CollectMatchedIDs:
		bitset.Bits(output.Matched[:words]).ForEach(func(ordinal uint32) bool {
			if id, live := s.src.idAt(ordinal); live {
				result.MatchedIDs = append(result.MatchedIDs, id)
			}
			return true
		})
	}
	return result, nil
}

func scoredBefore(left, right ScoredDocument) bool {
	if left.Score != right.Score {
		return left.Score > right.Score
	}
	return text.CompareCodePoints(left.ID, right.ID) < 0
}
