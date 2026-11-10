package query

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

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
}

type Phrase struct {
	Key     string
	Tokens  []string
	Offsets []uint32
}

type FieldBM25 struct {
	K1 float64
	B  float64
}

type BM25 struct {
	K1       float64
	B        float64
	PerField map[string]FieldBM25
}

type Statistics struct {
	TotalDocuments      float64
	FieldLengths        map[string]float64
	AverageLengths      map[string]float64
	DocumentFrequencies map[string]float64
}

type MatchedSet uint8

const (
	MatchedNone MatchedSet = iota
	MatchedOrdinals
)

type KeywordQuery struct {
	Tokens        []string
	Groups        []TermGroup
	PartialFields []string
	Phrases       []Phrase
	Fields        []string
	Boost         map[string]float64
	Tolerance     uint32
	PrefixLength  uint32
	Exact         bool
	BM25          *BM25
	Global        *Statistics
	TermMatch     uint32
	MinScore      float64
	HasLimit      bool
	Limit         int
	Filters       [][]uint32
	Collect       MatchedSet
	Work          *Work
	Order         DocumentOrder
	Components    bool
}

type Hit struct {
	Segment    int
	Ordinal    uint32
	Score      float64
	Components *model.ScoreComponents
}

type DocumentOrder func(left, right Hit) int

type KeywordResult struct {
	Hits         []Hit
	TotalMatched int
	Matched      [][]uint32
}

func (q *KeywordQuery) groupOf(token string) *TermGroup {
	for index := range q.Groups {
		if q.Groups[index].Token == token {
			return &q.Groups[index]
		}
	}
	return nil
}

func (q *KeywordQuery) filterOf(segment int) ([]uint32, bool) {
	if q.Filters == nil {
		return nil, false
	}
	if segment >= len(q.Filters) {
		return nil, true
	}
	return q.Filters[segment], true
}

func (g *TermGroup) holdsSynonym(token string) bool {
	for _, synonym := range g.Synonyms {
		if synonym == token {
			return true
		}
	}
	return false
}
