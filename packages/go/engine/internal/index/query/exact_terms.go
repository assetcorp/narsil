package query

import (
	"slices"
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type exactTerms struct {
	column      map[string]int
	units       []uint16
	offsets     []uint32
	row         map[*Segment]int
	ordinals    []uint32
	frequencies []uint32
	held        []uint32
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
	e.frequencies = e.frequencies[:0]
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
	e.frequencies = slices.Grow(e.frequencies, count)[:start+count]
	_, err := workspace.LookupExactBatch(segment.dictionary(), e.units, e.offsets, e.ordinals[start:])
	if err == nil {
		err = e.readFrequencies(segment, e.ordinals[start:], e.frequencies[start:])
	}
	if err != nil {
		e.ordinals, e.frequencies = e.ordinals[:start], e.frequencies[:start]
		return 0, err
	}
	e.row[segment] = start
	return start, nil
}

func (e *exactTerms) readFrequencies(segment *Segment, terms, into []uint32) error {
	held := e.held[:0]
	for _, term := range terms {
		if term != core.TermAbsent {
			held = append(held, term)
		}
	}
	e.held = held
	if err := core.DocumentFrequencies(segment.dictionary(), held, into); err != nil {
		return err
	}
	read := len(held)
	for at := len(terms) - 1; at >= 0; at-- {
		if terms[at] == core.TermAbsent {
			into[at] = 0
			continue
		}
		read--
		into[at] = into[read]
	}
	return nil
}

func (s *searcher) resolved(segment *Segment, token string) (int, bool, error) {
	column, known := s.terms.column[token]
	if !known || len(s.terms.units) == 0 {
		return 0, false, nil
	}
	start, err := s.terms.resolve(s.workspace, segment)
	return start + column, err == nil, err
}

func (s *searcher) exact(segment *Segment, token string) (uint32, bool, error) {
	at, batched, err := s.resolved(segment, token)
	if err != nil {
		return 0, false, err
	}
	if !batched {
		return s.finder.exact(s.workspace, segment, token)
	}
	term := s.terms.ordinals[at]
	return term, term != core.TermAbsent, nil
}

func (s *searcher) segmentFrequency(segment *Segment, token string) (float64, error) {
	at, batched, err := s.resolved(segment, token)
	if err != nil {
		return 0, err
	}
	if batched {
		return float64(s.terms.frequencies[at]), nil
	}
	if _, found, err := s.finder.exact(s.workspace, segment, token); err != nil || !found {
		return 0, err
	}
	counts, err := s.finder.frequencies(segment, s.finder.single[:])
	if err != nil {
		return 0, err
	}
	return float64(counts[0]), nil
}

func (s *searcher) matchFrequencies(segment *Segment, token string, matches []uint32) ([]uint32, error) {
	if len(matches) == 1 {
		at, batched, err := s.resolved(segment, token)
		if err != nil {
			return nil, err
		}
		if batched && s.terms.ordinals[at] == matches[0] {
			return s.terms.frequencies[at : at+1], nil
		}
	}
	return s.finder.frequencies(segment, matches)
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
