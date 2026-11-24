package query

import (
	"slices"
	"strings"
)

type FoldedTerm struct {
	Token       string
	Variants    []string
	TypoMatches []string
}

func (f *FoldedTerm) group() (TermGroup, bool) {
	if len(f.Variants) == 0 {
		return TermGroup{}, false
	}
	return TermGroup{
		Token:    f.Token,
		Members:  []GroupMember{{Token: f.Token, Factor: 1, PartialFactor: 1}},
		Synonyms: f.Variants,
	}, true
}

func (f *FoldedTerm) isVariant(token string) bool {
	return slices.Contains(f.Variants, token)
}

func (q *KeywordQuery) foldedOf(token string) *FoldedTerm {
	for index := range q.Folded {
		if q.Folded[index].Token == token {
			return &q.Folded[index]
		}
	}
	return nil
}

func (p *Phrase) variantsAt(at int) []string {
	if at >= len(p.Variants) {
		return nil
	}
	return p.Variants[at]
}

func (s *searcher) termMatches(segment *Segment, query *KeywordQuery, token string, group *TermGroup) ([]uint32, error) {
	matches, err := s.typoMatches(segment, query, token, group)
	folded := query.foldedOf(token)
	if err != nil || folded == nil {
		return matches, err
	}
	kept := make([]uint32, 0, len(matches)+len(folded.TypoMatches))
	for _, term := range matches {
		if matched := segment.termText(term); matched == token || !folded.isVariant(matched) {
			kept = append(kept, term)
		}
	}
	if len(folded.TypoMatches) == 0 {
		return kept, nil
	}
	for _, added := range folded.TypoMatches {
		term, found, err := s.exact(segment, added)
		if err != nil {
			return nil, err
		}
		if found && !slices.Contains(kept, term) {
			kept = append(kept, term)
		}
	}
	slices.SortFunc(kept, func(left, right uint32) int {
		return strings.Compare(segment.termText(left), segment.termText(right))
	})
	return kept, nil
}

func (q *KeywordQuery) foldedTokens() []string {
	var tokens []string
	for index := range q.Folded {
		tokens = append(tokens, q.Folded[index].Variants...)
		tokens = append(tokens, q.Folded[index].TypoMatches...)
	}
	for index := range q.Phrases {
		for _, variants := range q.Phrases[index].Variants {
			tokens = append(tokens, variants...)
		}
	}
	return tokens
}
