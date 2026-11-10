package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/synonyms"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type searchPlan struct {
	query          *model.QueryParams
	searches       bool
	term           analysedTerm
	written        map[int]string
	expansion      *synonyms.Expansion
	bm25           *model.BM25Params
	stats          *partition.GlobalStatistics
	work           *partition.WorkMeter
	needsAll       bool
	maxResults     int
	collectMatched bool
	components     bool
	tolerance      int
	prefixLength   int
	partialFields  []string
}

func (p *searchPlan) partialWords() partialWordOptions {
	return partialWordOptions{fields: p.partialFields, tolerance: p.tolerance, prefixLength: p.prefixLength}
}

type partitionOutcome struct {
	scored          []partition.ScoredDocument
	totalMatched    int
	matchedOrdinals bitset.Bits
	holdsOrdinals   bool
	matchedIDs      []string
}

func (q *preparedQuery) needsAllResults() bool {
	query := q.params
	return query.MinScore.IsSet() || termMatchFilters(query.TermMatch) || query.Sort != nil ||
		query.Group != nil || query.Pinned != nil || query.SearchAfter.IsSet()
}

func resultsToKeep(limit, offset int) int {
	if limit >= maxResultsPerPartition || offset >= maxResultsPerPartition-limit {
		return maxResultsPerPartition
	}
	return limit + offset + 1
}

func termMatchFilters(policy model.TermMatch) bool {
	kind := policy.Kind()
	return kind != model.TermMatchAbsent && kind != model.TermMatchAny
}

func (ix *Index) validateSearchFields(fields []string) error {
	for _, field := range fields {
		declared, found := ix.settings.Schema.Field(field)
		if !found {
			return narsilerr.New(narsilerr.CodeSearchInvalidField, `Field "`+field+`" does not exist in the schema`, map[string]any{"field": field})
		}
		if !declared.IsWordIndexed() {
			return narsilerr.New(narsilerr.CodeSearchInvalidField,
				`Field "`+field+`" has type "`+string(declared.Type)+`" which cannot be used for full-text search`,
				map[string]any{"field": field, "fieldType": string(declared.Type)})
		}
	}
	return nil
}

func (ix *Index) planSearch(query *preparedQuery, pass *analysis.Pass, analysed *analysedTerm) (*searchPlan, error) {
	params := query.params
	plan := &searchPlan{
		query:        &query.params,
		bm25:         query.bm25,
		work:         query.work,
		tolerance:    params.Tolerance.Or(0),
		prefixLength: params.PrefixLength.Or(defaultFuzzyPrefixLength),
		components:   params.IncludeScoreComponents || termMatchFilters(params.TermMatch),
		needsAll:     query.needsAllResults(),
	}
	if !plan.needsAll {
		plan.maxResults = resultsToKeep(query.limit, query.offset)
	}
	plan.collectMatched = params.Facets != nil && !plan.needsAll
	if analysed == nil || (params.Fields != nil && len(params.Fields) == 0) {
		return plan, nil
	}
	if params.Fields != nil {
		if err := ix.validateSearchFields(params.Fields); err != nil {
			return nil, err
		}
	}
	plan.term = *analysed
	if len(plan.term.tokens) == 0 && len(plan.term.phrases()) == 0 {
		return plan, nil
	}
	plan.searches = true
	if len(plan.term.tokens) == 0 || params.Exact {
		return plan, nil
	}
	plan.expansion = ix.Synonyms().Expand(uniqueTokenTerms(plan.term.unique))
	plan.partialFields = ix.partialFieldsFor(&query.params)
	if plan.term.usesPrefix || len(plan.partialFields) > 0 {
		written, err := writtenWordsByPosition(plan.term.words, pass)
		if err != nil {
			return nil, err
		}
		plan.written = written
	}
	return plan, nil
}

func groupFor(groups *[]partition.TermGroup, token string, typoMatches bool) *partition.TermGroup {
	for at := range *groups {
		if (*groups)[at].Token == token {
			return &(*groups)[at]
		}
	}
	*groups = append(*groups, partition.TermGroup{
		Token:       token,
		Members:     []partition.GroupMember{{Token: token, Factor: 1, PartialFactor: 1}},
		TypoMatches: typoMatches,
	})
	return &(*groups)[len(*groups)-1]
}

func termGroupsFor(view partition.View, term *analysedTerm, written map[int]string, usesPrefix bool, expansion *synonyms.Expansion, partial partialWordOptions) []partition.TermGroup {
	var groups []partition.TermGroup
	last, hasLast := term.lastToken()
	if usesPrefix && hasLast {
		if typed := written[last.Position]; typed != "" {
			group := groupFor(&groups, last.Token, false)
			ownLength := float64(text.CodePointCount(last.Token))
			for _, completion := range view.ExpandTermPrefix(typed, last.Token, prefixMaxExpansions) {
				if completion == last.Token {
					continue
				}
				factor := min(1, ownLength/float64(text.CodePointCount(completion)))
				group.Members = append(group.Members, partition.GroupMember{Token: completion, Factor: factor, PartialFactor: factor})
			}
		}
	}
	if len(partial.fields) > 0 {
		addPartialWordMembers(&groups, view, term, written, partial)
	}
	if expansion != nil {
		for _, expanded := range expansion.Expanded {
			group := groupFor(&groups, expanded.Token, true)
			group.Synonyms = expanded.Synonyms
			group.HasSynonyms = true
			kept := group.Members[:0]
			for _, member := range group.Members {
				if member.Token == expanded.Token || !expanded.Has(member.Token) {
					kept = append(kept, member)
				}
			}
			group.Members = kept
		}
	}
	return groups
}

func (ix *Index) searchPartition(view partition.View, plan *searchPlan, filter *partitionFilter) (partitionOutcome, error) {
	if !plan.searches {
		return partitionOutcome{}, nil
	}
	params := partition.SearchParams{
		QueryTokens:       plan.term.unique,
		Phrases:           plan.term.phrases(),
		PhraseWork:        plan.work,
		Fields:            plan.query.Fields,
		HasFields:         plan.query.Fields != nil,
		Boost:             plan.query.Boost,
		Tolerance:         plan.tolerance,
		PrefixLength:      plan.prefixLength,
		Exact:             plan.query.Exact,
		BM25:              plan.bm25,
		GlobalStats:       plan.stats,
		MaxResults:        plan.maxResults,
		HasMaxResults:     !plan.needsAll,
		CollectComponents: plan.components,
	}
	params.HasPhrases = len(params.Phrases) > 0
	if plan.collectMatched {
		params.CollectMatched = partition.CollectMatchedOrdinals
	}
	if filter != nil {
		bits, err := filter.matches(view)
		if err != nil {
			return partitionOutcome{}, err
		}
		if bits.IsEmpty() {
			return partitionOutcome{}, nil
		}
		params.Filter, params.HasFilter = bits, true
	}
	if len(plan.term.tokens) > 0 && !plan.query.Exact && (plan.term.usesPrefix || plan.expansion != nil || len(plan.partialFields) > 0) {
		params.TermGroups = termGroupsFor(view, &plan.term, plan.written, plan.term.usesPrefix, plan.expansion, plan.partialWords())
		if len(params.TermGroups) > 0 && len(plan.partialFields) > 0 {
			params.PartialFields = plan.partialFields
		}
	}
	found, err := view.SearchFulltext(&params)
	if err != nil {
		return partitionOutcome{}, err
	}
	scored := found.Scored
	if termMatchFilters(plan.query.TermMatch) && len(params.QueryTokens) > 0 {
		scored = filterByTermCoverage(scored, &params, plan.query.TermMatch)
	}
	if minimum, set := plan.query.MinScore.Get(); set && minimum > 0 {
		kept := scored[:0]
		for _, document := range scored {
			if document.Score >= minimum {
				kept = append(kept, document)
			}
		}
		scored = kept
	}
	outcome := partitionOutcome{scored: scored, totalMatched: found.TotalMatched}
	if plan.needsAll {
		outcome.totalMatched = len(scored)
	}
	if plan.query.Facets == nil {
		return outcome, nil
	}
	if plan.needsAll {
		outcome.matchedIDs = make([]string, len(scored))
		for at, document := range scored {
			outcome.matchedIDs[at] = document.ID
		}
		return outcome, nil
	}
	outcome.matchedOrdinals, outcome.holdsOrdinals = found.MatchedOrdinals, true
	return outcome, nil
}
