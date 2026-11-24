package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/query"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type tokenSet struct {
	order []string
	held  map[string]struct{}
}

func (s *tokenSet) add(token string) {
	if s.held == nil {
		s.held = map[string]struct{}{}
	}
	if _, found := s.held[token]; found {
		return
	}
	s.held[token] = struct{}{}
	s.order = append(s.order, token)
}

func (ix *Index) statsTokensOf(plan *searchPlan) *tokenSet {
	tokens := &tokenSet{}
	for _, token := range plan.term.unique {
		tokens.add(token.Token)
	}
	expansion := plan.expansion
	if expansion == nil && len(plan.term.unique) > 0 {
		expansion = ix.Synonyms().Expand(uniqueTokenTerms(plan.term.unique))
	}
	if expansion != nil {
		for _, synonym := range expansion.Tokens {
			tokens.add(synonym)
		}
	}
	for _, phrase := range plan.term.phrases() {
		for _, token := range phrase.Tokens {
			tokens.add(token)
		}
	}
	return tokens
}

func addReachedTokens(tokens *tokenSet, views []*query.View, plan *searchPlan) error {
	params := plan.query
	if params.Exact || len(plan.term.tokens) == 0 {
		return nil
	}
	if !(plan.tolerance > 0 || plan.term.usesPrefix || params.PartialWords) {
		return nil
	}
	if plan.tolerance > 0 {
		reached, err := query.TypoTokens(views, uniqueTokenTerms(plan.term.unique), uint32(plan.tolerance), uint32(plan.prefixLength))
		if err != nil {
			return err
		}
		for _, token := range reached {
			tokens.add(token)
		}
	}
	if !plan.term.usesPrefix && len(plan.partialFields) == 0 {
		return nil
	}
	for _, view := range views {
		groups, err := termGroupsFor(view, plan, nil)
		if err != nil {
			return err
		}
		for _, group := range groups {
			for _, member := range group.Members {
				if member.Token != group.Token {
					tokens.add(member.Token)
				}
			}
		}
	}
	return nil
}

func addFoldedTokens(tokens *tokenSet, views []*query.View, plan *searchPlan) error {
	if plan.folding == nil {
		return nil
	}
	groupsNeeded := len(plan.term.tokens) > 0 && (plan.term.usesPrefix || plan.expansion != nil || len(plan.partialFields) > 0)
	for _, view := range views {
		var groups []query.TermGroup
		if groupsNeeded {
			found, err := termGroupsFor(view, plan, plan.expansion)
			if err != nil {
				return err
			}
			groups = found
		}
		folded, phrases, err := resolveFolding(view, plan.folding, groups, plan.term.phrases())
		if err != nil {
			return err
		}
		for _, term := range folded {
			for _, token := range term.Variants {
				tokens.add(token)
			}
			for _, token := range term.TypoMatches {
				tokens.add(token)
			}
		}
		for _, phrase := range phrases {
			for _, variants := range phrase.Variants {
				for _, token := range variants {
					tokens.add(token)
				}
			}
		}
	}
	return nil
}

func (ix *Index) collectQueryTermStats(views []*query.View, plan *searchPlan) (*query.Statistics, error) {
	tokens := ix.statsTokensOf(plan)
	if err := addReachedTokens(tokens, views, plan); err != nil {
		return nil, err
	}
	if err := addFoldedTokens(tokens, views, plan); err != nil {
		return nil, err
	}
	return query.CollectStatistics(views, tokens.order)
}

func (ix *Index) scoringModeOf(params *model.QueryParams) model.ScoringMode {
	if params.Scoring != "" {
		return params.Scoring
	}
	if ix.settings.DefaultScoring != "" {
		return ix.settings.DefaultScoring
	}
	return model.ScoringLocal
}
