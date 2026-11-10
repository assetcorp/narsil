package index

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type coverageGroup struct {
	members     map[string]struct{}
	partialOnly map[string]struct{}
	typoMatches bool
}

func coverageGroupsOf(groups []partition.TermGroup) map[string]coverageGroup {
	covered := make(map[string]coverageGroup, len(groups))
	for _, group := range groups {
		entry := coverageGroup{members: map[string]struct{}{}, partialOnly: map[string]struct{}{}, typoMatches: group.TypoMatches}
		for _, member := range group.Members {
			entry.members[member.Token] = struct{}{}
			if member.Factor == 0 {
				entry.partialOnly[member.Token] = struct{}{}
			}
		}
		for _, synonym := range group.Synonyms {
			entry.members[synonym] = struct{}{}
		}
		covered[group.Token] = entry
	}
	return covered
}

func filterByTermCoverage(scored []partition.ScoredDocument, params *partition.SearchParams, policy model.TermMatch) []partition.ScoredDocument {
	required := float64(len(params.QueryTokens))
	if count, counted := policy.Count(); counted {
		required = count
	}
	if required <= 0 {
		return scored
	}
	if required > float64(len(params.QueryTokens)) {
		return []partition.ScoredDocument{}
	}
	var phraseKeys map[string]struct{}
	if params.HasPhrases {
		phraseKeys = make(map[string]struct{}, len(params.Phrases))
		for _, phrase := range params.Phrases {
			phraseKeys[phrase.Key] = struct{}{}
		}
	}
	groups := coverageGroupsOf(params.TermGroups)
	kept := scored[:0:0]
	for _, document := range scored {
		if float64(countDocumentTermMatches(document, params, groups, phraseKeys)) >= required {
			kept = append(kept, document)
		}
	}
	return kept
}

func indexTokensOf(document partition.ScoredDocument, phraseKeys map[string]struct{}) []string {
	if document.Components == nil {
		return nil
	}
	tokens := make([]string, 0, len(document.Components.IDF))
	for key := range document.Components.IDF {
		if _, phrase := phraseKeys[key]; !phrase {
			tokens = append(tokens, key)
		}
	}
	return tokens
}

func countDocumentTermMatches(document partition.ScoredDocument, params *partition.SearchParams, groups map[string]coverageGroup, phraseKeys map[string]struct{}) int {
	indexTokens := indexTokensOf(document, phraseKeys)
	if len(indexTokens) == 0 {
		return 0
	}
	count := 0
	for _, queryToken := range params.QueryTokens {
		group, grouped := groups[queryToken.Token]
		satisfied := false
		if !grouped {
			satisfied = queryTermSatisfied(queryToken.Token, indexTokens, params)
		} else {
			satisfied = groupSatisfied(group, document, indexTokens, params.PartialFields) ||
				group.typoMatches && queryTermSatisfied(queryToken.Token, indexTokens, params)
		}
		if satisfied {
			count++
		}
	}
	return count
}

func matchedInPartialField(document partition.ScoredDocument, token string, partialFields []string) bool {
	for _, field := range partialFields {
		if _, found := document.Components.TermFrequencies[field+":"+token]; found {
			return true
		}
	}
	return false
}

func groupSatisfied(group coverageGroup, document partition.ScoredDocument, indexTokens []string, partialFields []string) bool {
	for _, indexToken := range indexTokens {
		if _, member := group.members[indexToken]; !member {
			continue
		}
		if _, partialOnly := group.partialOnly[indexToken]; !partialOnly || matchedInPartialField(document, indexToken, partialFields) {
			return true
		}
	}
	return false
}

func queryTermSatisfied(queryToken string, indexTokens []string, params *partition.SearchParams) bool {
	if params.Exact || params.Tolerance == 0 {
		for _, indexToken := range indexTokens {
			if indexToken == queryToken {
				return true
			}
		}
		return false
	}
	for _, indexToken := range indexTokens {
		if postings.FuzzyTermMatches(queryToken, indexToken, params.Tolerance, params.PrefixLength) {
			return true
		}
	}
	return false
}
