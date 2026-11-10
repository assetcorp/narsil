package partition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type QueryToken struct {
	Token    string
	Position int
}

type GroupMember struct {
	Token         string
	Factor        float64
	PartialFactor float64
}

type TermGroup struct {
	Token       string
	Members     []GroupMember
	TypoMatches bool
	Synonyms    []string
	HasSynonyms bool
}

func (g *TermGroup) HoldsSynonym(token string) bool {
	for _, synonym := range g.Synonyms {
		if synonym == token {
			return true
		}
	}
	return false
}

type GlobalStatistics struct {
	TotalDocuments      float64
	AverageFieldLengths map[string]float64
	DocFrequencies      map[string]float64
}

type Phrase struct {
	Key     string
	Tokens  []string
	Offsets []int
}

type MatchedSet uint8

const (
	CollectNoMatches MatchedSet = iota
	CollectMatchedOrdinals
	CollectMatchedIDs
)

type SearchParams struct {
	QueryTokens       []QueryToken
	Phrases           []Phrase
	HasPhrases        bool
	PhraseWork        *WorkMeter
	TermGroups        []TermGroup
	PartialFields     []string
	Fields            []string
	HasFields         bool
	Boost             map[string]float64
	Tolerance         int
	PrefixLength      int
	Exact             bool
	BM25              *model.BM25Params
	GlobalStats       *GlobalStatistics
	MaxResults        int
	HasMaxResults     bool
	Filter            bitset.Bits
	HasFilter         bool
	CollectComponents bool
	CollectMatched    MatchedSet
}

type ScoredDocument struct {
	ID         string
	Ordinal    uint32
	Score      float64
	Components *model.ScoreComponents
	Document   *StoredDocument
}

type SearchResult struct {
	Scored          []ScoredDocument
	TotalMatched    int
	MatchedOrdinals bitset.Bits
	MatchedIDs      []string
}

func termGroupOf(groups []TermGroup, token string) *TermGroup {
	for index := range groups {
		if groups[index].Token == token {
			return &groups[index]
		}
	}
	return nil
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
