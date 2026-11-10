package query

import (
	"math"
	"strings"
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	SynonymsAddedPerQuery        = 50
	SynonymExpansionCacheEntries = 1_024
	synonymCacheKeySeparator     = "\x00"
)

type SynonymSelector struct {
	table *core.SynonymTable
	cache map[string]map[string][]string
	order []string
}

func NewSynonymSelector(table *core.SynonymTable) *SynonymSelector {
	return &SynonymSelector{table: table, cache: map[string]map[string][]string{}}
}

func (s *SynonymSelector) touch(key string) {
	for at, held := range s.order {
		if held == key {
			s.order = append(s.order[:at], s.order[at+1:]...)
			break
		}
	}
	s.order = append(s.order, key)
}

func (s *SynonymSelector) word(rank uint32) (string, bool) {
	if uint64(rank)+1 >= uint64(len(s.table.Offsets)) {
		return "", false
	}
	start, end := s.table.Offsets[rank], s.table.Offsets[rank+1]
	if start > end || int(end) > len(s.table.Tokens) {
		return "", false
	}
	return string(s.table.Tokens[start:end]), true
}

func (s *SynonymSelector) Select(input []string) (map[string][]string, error) {
	seen := map[string]bool{}
	tokens := make([]string, 0, len(input))
	for _, token := range input {
		if !seen[token] {
			seen[token] = true
			tokens = append(tokens, token)
		}
	}
	key := strings.Join(tokens, synonymCacheKeySeparator)
	if cached, found := s.cache[key]; found {
		s.touch(key)
		return cached, nil
	}
	request := &core.SynonymRequest{Table: s.table, Starts: make([]uint32, len(tokens)+1)}
	for at, token := range tokens {
		request.Starts[at] = uint32(len(request.Units))
		request.Units = append(request.Units, utf16.Encode([]rune(token))...)
		if uint64(len(request.Units)) > math.MaxUint32 {
			return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "The synonym query exceeds the text layout", nil)
		}
	}
	request.Starts[len(tokens)] = uint32(len(request.Units))
	output := &core.SynonymOutput{
		Queries: make([]uint32, SynonymsAddedPerQuery), Starts: make([]uint32, SynonymsAddedPerQuery+1), Tokens: make([]uint32, SynonymsAddedPerQuery),
	}
	count, err := core.ExpandSynonyms(request, output)
	if err != nil {
		return nil, narsilerr.Wrap(narsilerr.CodeConfigInvalid, "The synonym query could not be expanded", err, nil)
	}
	groups := make(map[string][]string, count)
	for group := range count {
		synonyms := []string{}
		for at := output.Starts[group]; at < output.Starts[group+1]; at++ {
			word, held := s.word(output.Tokens[at])
			if !held {
				return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "The synonym table names a word outside its regions", nil)
			}
			synonyms = append(synonyms, word)
		}
		if int(output.Queries[group]) >= len(tokens) {
			return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "The synonym expansion names a token outside the query", nil)
		}
		groups[tokens[output.Queries[group]]] = synonyms
	}
	if len(s.cache) >= SynonymExpansionCacheEntries && len(s.order) > 0 {
		delete(s.cache, s.order[0])
		s.order = s.order[1:]
	}
	s.cache[key] = groups
	s.order = append(s.order, key)
	return groups, nil
}
