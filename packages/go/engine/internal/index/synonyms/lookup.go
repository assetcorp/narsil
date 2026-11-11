package synonyms

import (
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type Lookup struct {
	blob           []byte
	offsets        []uint32
	ruleStart      []uint32
	ruleTokens     []uint32
	tokenRuleStart []uint32
	tokenRules     []uint32
	tokenCount     int
	bytes          int64
	cache          *synonymCache
}

func (l *Lookup) sharedSynonymsOf(token string) []string {
	if l == nil {
		return nil
	}
	key := text.ToWellFormed(token)
	if cached, found := l.cache.get(key); found {
		return cached
	}
	rank, found := l.rankOf(key)
	if !found {
		return nil
	}
	synonyms := l.collect(rank)
	l.cache.put(key, synonyms)
	return synonyms
}

func compareStoredToken(stored []byte, key string) int {
	shorter := min(len(stored), len(key))
	for at := range shorter {
		if stored[at] != key[at] {
			if stored[at] < key[at] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(stored) < len(key):
		return -1
	case len(stored) > len(key):
		return 1
	}
	return 0
}

func (l *Lookup) storedToken(rank uint32) []byte {
	return l.blob[l.offsets[rank]:l.offsets[rank+1]]
}

func (l *Lookup) rankOf(key string) (uint32, bool) {
	low, high := 0, len(l.offsets)-2
	for low <= high {
		middle := int(uint(low+high) >> 1)
		order := compareStoredToken(l.storedToken(uint32(middle)), key)
		if order == 0 {
			return uint32(middle), true
		}
		if order < 0 {
			low = middle + 1
		} else {
			high = middle - 1
		}
	}
	return 0, false
}

func (l *Lookup) collect(token uint32) []string {
	var found []uint32
	for at := l.tokenRuleStart[token]; at < l.tokenRuleStart[token+1]; at++ {
		rule := l.tokenRules[at]
		for member := l.ruleStart[rule]; member < l.ruleStart[rule+1]; member++ {
			if l.ruleTokens[member] != token {
				found = append(found, l.ruleTokens[member])
			}
		}
	}
	if len(found) == 0 {
		return nil
	}
	slices.Sort(found)
	synonyms := make([]string, 0, min(len(found), synonymsAddedPerQuery))
	for at, rank := range found {
		if len(synonyms) == synonymsAddedPerQuery {
			break
		}
		if at > 0 && rank == found[at-1] {
			continue
		}
		synonyms = append(synonyms, string(l.storedToken(rank)))
	}
	return slices.Clip(synonyms)
}
