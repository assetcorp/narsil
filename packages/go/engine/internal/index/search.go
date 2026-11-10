package index

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/analysis"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/synonyms"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type searchPlan struct {
	query         *model.QueryParams
	searches      bool
	term          analysedTerm
	written       map[int]string
	expansion     *synonyms.Expansion
	bm25          *query.BM25
	stats         *query.Statistics
	work          *core.WorkMeter
	filters       *filterRun
	needsAll      bool
	sortedPage    bool
	maxResults    int
	tolerance     int
	prefixLength  int
	partialFields []string
}

func (p *searchPlan) partialWords() partialWordOptions {
	return partialWordOptions{fields: p.partialFields, tolerance: p.tolerance, prefixLength: p.prefixLength}
}

type partitionOutcome struct {
	scored       []scoredHit
	totalMatched int
	matched      [][]uint32
}

func (q *preparedQuery) needsAllResults() bool {
	params := q.params
	return params.MinScore.IsSet() || termMatchFilters(params.TermMatch) || params.Sort != nil ||
		params.Group != nil || params.Pinned != nil || params.SearchAfter.IsSet()
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

func requiredTermMatches(policy model.TermMatch, tokens int) uint32 {
	switch policy.Kind() {
	case model.TermMatchAll:
		return uint32(tokens)
	case model.TermMatchCount:
		count, _ := policy.Count()
		if !(count > 0) {
			return 0
		}
		return uint32(min(math.Ceil(count), math.MaxUint32))
	}
	return 0
}

func keywordBM25(params *model.BM25Params) *query.BM25 {
	if params == nil {
		return nil
	}
	k1, b := params.K1.Or(query.DefaultBM25K1), params.B.Or(query.DefaultBM25B)
	converted := &query.BM25{K1: k1, B: b}
	if len(params.Fields) > 0 {
		converted.PerField = make(map[string]query.FieldBM25, len(params.Fields))
		for name, pair := range params.Fields {
			converted.PerField[name] = query.FieldBM25{K1: pair.K1.Or(k1), B: pair.B.Or(b)}
		}
	}
	return converted
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

func (ix *Index) planSearch(prepared *preparedQuery, pass *analysis.Pass, analysed *analysedTerm) (*searchPlan, error) {
	params := prepared.params
	plan := &searchPlan{
		query:        &prepared.params,
		bm25:         keywordBM25(prepared.bm25),
		work:         prepared.work,
		filters:      prepared.filters,
		tolerance:    params.Tolerance.Or(0),
		prefixLength: params.PrefixLength.Or(defaultFuzzyPrefixLength),
		needsAll:     prepared.needsAllResults(),
	}
	if !plan.needsAll {
		plan.maxResults = resultsToKeep(prepared.limit, prepared.offset)
	}
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
	plan.partialFields = ix.partialFieldsFor(&prepared.params)
	if plan.term.usesPrefix || len(plan.partialFields) > 0 {
		written, err := writtenWordsByPosition(plan.term.words, pass)
		if err != nil {
			return nil, err
		}
		plan.written = written
	}
	return plan, nil
}

func groupFor(groups *[]query.TermGroup, token string, typoMatches bool) *query.TermGroup {
	for at := range *groups {
		if (*groups)[at].Token == token {
			return &(*groups)[at]
		}
	}
	*groups = append(*groups, query.TermGroup{
		Token:       token,
		Members:     []query.GroupMember{{Token: token, Factor: 1, PartialFactor: 1}},
		TypoMatches: typoMatches,
	})
	return &(*groups)[len(*groups)-1]
}

func addPrefixCompletions(groups *[]query.TermGroup, view *query.View, term *analysedTerm, written map[int]string) error {
	last, hasLast := term.lastToken()
	if !hasLast {
		return nil
	}
	typed := written[last.Position]
	if typed == "" {
		return nil
	}
	group := groupFor(groups, last.Token, false)
	completions, err := query.ExpandPrefix(view, typed, last.Token, prefixMaxExpansions)
	if err != nil {
		return err
	}
	for _, completion := range completions {
		if completion.Token == last.Token {
			continue
		}
		group.Members = append(group.Members, query.GroupMember{Token: completion.Token, Factor: completion.Factor, PartialFactor: completion.Factor})
	}
	return nil
}

func termGroupsFor(view *query.View, plan *searchPlan, expansion *synonyms.Expansion) ([]query.TermGroup, error) {
	var groups []query.TermGroup
	if plan.term.usesPrefix {
		if err := addPrefixCompletions(&groups, view, &plan.term, plan.written); err != nil {
			return nil, err
		}
	}
	if len(plan.partialFields) > 0 {
		if err := addPartialWordMembers(&groups, view, &plan.term, plan.written, plan.partialWords()); err != nil {
			return nil, err
		}
	}
	if expansion == nil {
		return groups, nil
	}
	for _, expanded := range expansion.Expanded {
		group := groupFor(&groups, expanded.Token, true)
		group.Synonyms = expanded.Synonyms
		kept := group.Members[:0]
		for _, member := range group.Members {
			if member.Token == expanded.Token || !expanded.Has(member.Token) {
				kept = append(kept, member)
			}
		}
		group.Members = kept
	}
	return groups, nil
}

func (plan *searchPlan) keywordQuery(snapshot partition.Snapshot) *query.KeywordQuery {
	params := plan.query
	keyword := &query.KeywordQuery{
		Tokens:       uniqueTokenTerms(plan.term.unique),
		Phrases:      plan.term.phrases(),
		Fields:       params.Fields,
		Boost:        params.Boost,
		Tolerance:    uint32(plan.tolerance),
		PrefixLength: uint32(plan.prefixLength),
		Exact:        params.Exact,
		BM25:         plan.bm25,
		Global:       plan.stats,
		TermMatch:    requiredTermMatches(params.TermMatch, len(plan.term.unique)),
		HasLimit:     !plan.needsAll,
		Limit:        plan.maxResults,
		Meter:        plan.work,
		Components:   params.IncludeScoreComponents,
		Order: func(left, right query.Hit) int {
			leftID, _ := snapshot.IDAt(left.Segment, left.Ordinal)
			rightID, _ := snapshot.IDAt(right.Segment, right.Ordinal)
			return text.CompareCodePoints(leftID, rightID)
		},
	}
	if minimum, set := params.MinScore.Get(); set && minimum > 0 {
		keyword.MinScore = minimum
	}
	if params.Facets != nil || plan.sortedPage {
		keyword.Collect = query.MatchedOrdinals
	}
	return keyword
}

func missingHitDocument(segment int, ordinal uint32) error {
	return narsilerr.New(narsilerr.CodePartitionCorrupted, "A search hit names a document that the partition does not hold",
		map[string]any{"segment": segment, "ordinal": ordinal})
}

func (ix *Index) searchPartition(snapshot partition.Snapshot, view *query.View, plan *searchPlan) (partitionOutcome, error) {
	if !plan.searches {
		return partitionOutcome{}, nil
	}
	keyword := plan.keywordQuery(snapshot)
	if plan.filters != nil {
		accepted, err := plan.filters.evaluate(view)
		if err != nil {
			return partitionOutcome{}, err
		}
		if !anyBitSet(accepted) {
			return partitionOutcome{}, nil
		}
		keyword.Filters = accepted
	}
	if len(plan.term.tokens) > 0 && !plan.query.Exact && (plan.term.usesPrefix || plan.expansion != nil || len(plan.partialFields) > 0) {
		groups, err := termGroupsFor(view, plan, plan.expansion)
		if err != nil {
			return partitionOutcome{}, err
		}
		keyword.Groups = groups
		if len(groups) > 0 && len(plan.partialFields) > 0 {
			keyword.PartialFields = plan.partialFields
		}
	}
	found, err := query.Search(view, keyword)
	if err != nil {
		return partitionOutcome{}, err
	}
	return outcomeOf(snapshot, found)
}

func outcomeOf(snapshot partition.Snapshot, found *query.KeywordResult) (partitionOutcome, error) {
	scored := make([]scoredHit, len(found.Hits))
	for at, hit := range found.Hits {
		id, held := snapshot.IDAt(hit.Segment, hit.Ordinal)
		if !held {
			return partitionOutcome{}, missingHitDocument(hit.Segment, hit.Ordinal)
		}
		scored[at] = scoredHit{ID: id, Score: hit.Score, Components: hit.Components}
	}
	return partitionOutcome{scored: scored, totalMatched: found.TotalMatched, matched: found.Matched}, nil
}
