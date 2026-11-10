package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (ix *Index) statsTokensOf(plan *searchPlan) map[string]struct{} {
	tokens := map[string]struct{}{}
	for _, token := range plan.term.unique {
		tokens[token.Token] = struct{}{}
	}
	expansion := plan.expansion
	if expansion == nil && len(plan.term.unique) > 0 {
		expansion = ix.Synonyms().Expand(uniqueTokenTerms(plan.term.unique))
	}
	if expansion != nil {
		for _, synonym := range expansion.Tokens {
			tokens[synonym] = struct{}{}
		}
	}
	for _, phrase := range plan.term.phrases() {
		for _, token := range phrase.Tokens {
			tokens[token] = struct{}{}
		}
	}
	return tokens
}

func addReachedTokens(tokens map[string]struct{}, views []partition.View, plan *searchPlan) {
	query := plan.query
	if query.Exact || len(plan.term.tokens) == 0 {
		return
	}
	partial := plan.partialWords()
	if !(plan.tolerance > 0 || plan.term.usesPrefix || query.PartialWords) {
		return
	}
	added := map[string]struct{}{}
	for _, view := range views {
		if plan.tolerance > 0 {
			for _, token := range plan.term.unique {
				for _, match := range view.FuzzyTokens(token.Token, plan.tolerance, plan.prefixLength) {
					tokens[match] = struct{}{}
				}
			}
		}
		if !plan.term.usesPrefix && len(partial.fields) == 0 {
			continue
		}
		for _, group := range termGroupsFor(view, &plan.term, plan.written, plan.term.usesPrefix, nil, partial) {
			for _, member := range group.Members {
				if member.Token != group.Token {
					added[member.Token] = struct{}{}
				}
			}
		}
	}
	for token := range added {
		tokens[token] = struct{}{}
	}
}

func (ix *Index) collectQueryTermStats(views []partition.View, plan *searchPlan) *partition.GlobalStatistics {
	tokens := ix.statsTokensOf(plan)
	addReachedTokens(tokens, views, plan)
	stats := &partition.GlobalStatistics{AverageFieldLengths: map[string]float64{}, DocFrequencies: map[string]float64{}}
	totalFieldLengths := map[string]float64{}
	for _, view := range views {
		stats.TotalDocuments += float64(view.TotalDocuments())
		for field, length := range view.TotalFieldLengths() {
			totalFieldLengths[field] += length
		}
		for token := range tokens {
			if frequency, present := view.DocumentFrequency(token); present {
				stats.DocFrequencies[token] += float64(frequency)
			}
		}
	}
	if stats.TotalDocuments > 0 {
		for field, total := range totalFieldLengths {
			stats.AverageFieldLengths[field] = total / stats.TotalDocuments
		}
	}
	return stats
}

func (ix *Index) scoringModeOf(query *model.QueryParams) model.ScoringMode {
	if query.Scoring != "" {
		return query.Scoring
	}
	if ix.settings.DefaultScoring != "" {
		return ix.settings.DefaultScoring
	}
	return model.ScoringLocal
}
