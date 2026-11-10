package synonyms

import "slices"

type ExpandedToken struct {
	Token    string
	Synonyms []string
}

type Expansion struct {
	Tokens   []string
	Expanded []ExpandedToken
}

func (t ExpandedToken) Has(token string) bool {
	return slices.Contains(t.Synonyms, token)
}

func (l *Lookup) Expand(queryTokens []string) *Expansion {
	if l == nil {
		return nil
	}
	var withSynonyms []ExpandedToken
	seen := make(map[string]struct{}, len(queryTokens))
	for _, token := range queryTokens {
		if _, repeated := seen[token]; repeated {
			continue
		}
		seen[token] = struct{}{}
		if synonyms := l.sharedSynonymsOf(token); len(synonyms) > 0 {
			withSynonyms = append(withSynonyms, ExpandedToken{Token: token, Synonyms: synonyms})
		}
		if len(withSynonyms) == synonymsAddedPerQuery {
			break
		}
	}
	count := len(withSynonyms)
	if count == 0 {
		return nil
	}
	share := synonymsAddedPerQuery / count
	extra := synonymsAddedPerQuery % count
	expansion := &Expansion{Expanded: make([]ExpandedToken, count)}
	added := make(map[string]struct{}, synonymsAddedPerQuery)
	for at, entry := range withSynonyms {
		quota := share
		if at < extra {
			quota++
		}
		kept := slices.Clone(entry.Synonyms[:min(quota, len(entry.Synonyms))])
		expansion.Expanded[at] = ExpandedToken{Token: entry.Token, Synonyms: kept}
		for _, synonym := range kept {
			if _, present := added[synonym]; present {
				continue
			}
			added[synonym] = struct{}{}
			expansion.Tokens = append(expansion.Tokens, synonym)
		}
	}
	return expansion
}
