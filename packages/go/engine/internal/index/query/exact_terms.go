package query

import (
	"slices"
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type exactTerms struct {
	column   map[string]int
	units    []uint16
	offsets  []uint32
	row      map[*Segment]int
	ordinals []uint32
}

func (e *exactTerms) reset() {
	if e.column == nil {
		e.column = map[string]int{}
		e.row = map[*Segment]int{}
	}
	clear(e.column)
	clear(e.row)
	e.units = e.units[:0]
	e.offsets = append(e.offsets[:0], 0)
	e.ordinals = e.ordinals[:0]
}

func (e *exactTerms) add(token string) {
	if _, known := e.column[token]; known || token == "" || len(e.row) > 0 {
		return
	}
	e.column[token] = len(e.offsets) - 1
	for _, point := range token {
		if point >= 0x10000 {
			high, low := utf16.EncodeRune(point)
			e.units = append(e.units, uint16(high), uint16(low))
			continue
		}
		e.units = append(e.units, uint16(point))
	}
	e.offsets = append(e.offsets, uint32(len(e.units)))
}

func (e *exactTerms) addQuery(query *KeywordQuery) {
	for _, token := range query.Tokens {
		e.add(token)
	}
	for index := range query.Groups {
		group := &query.Groups[index]
		e.add(group.Token)
		for _, member := range group.Members {
			e.add(member.Token)
		}
		for _, synonym := range group.Synonyms {
			e.add(synonym)
		}
	}
	for index := range query.Phrases {
		for _, token := range query.Phrases[index].Tokens {
			e.add(token)
		}
	}
}

func (e *exactTerms) resolve(workspace *core.Workspace, segment *Segment) (int, error) {
	if start, resolved := e.row[segment]; resolved {
		return start, nil
	}
	count := len(e.offsets) - 1
	start := len(e.ordinals)
	e.ordinals = slices.Grow(e.ordinals, count)[:start+count]
	if _, err := workspace.LookupExactBatch(segment.dictionary(), e.units, e.offsets, e.ordinals[start:]); err != nil {
		e.ordinals = e.ordinals[:start]
		return 0, err
	}
	e.row[segment] = start
	return start, nil
}

func (s *searcher) exact(segment *Segment, token string) (uint32, bool, error) {
	column, known := s.terms.column[token]
	if !known || len(s.terms.units) == 0 {
		return s.finder.exact(s.workspace, segment, token)
	}
	start, err := s.terms.resolve(s.workspace, segment)
	if err != nil {
		return 0, false, err
	}
	term := s.terms.ordinals[start+column]
	return term, term != core.TermAbsent, nil
}

func (s *searcher) typo(segment *Segment, token string, tolerance, prefixLength uint32) ([]uint32, error) {
	if tolerance > 0 {
		return s.finder.typo(s.workspace, segment, token, tolerance, prefixLength)
	}
	term, found, err := s.exact(segment, token)
	if err != nil || !found {
		return nil, err
	}
	s.finder.ordinals = append(s.finder.ordinals[:0], term)
	return s.finder.ordinals, nil
}
