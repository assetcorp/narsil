package query

import (
	"unicode/utf16"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type postingList struct {
	term    uint32
	start   uint32
	length  uint32
	ordered bool
}

func (s *Segment) termCount() int {
	if s.Growing != nil {
		return int(s.Growing.Terms.Header[core.TermHeaderCount])
	}
	return len(s.Frozen.Terms.Counts)
}

func (s *Segment) termText(term uint32) string {
	if s.Growing != nil {
		table := &s.Growing.Terms
		if int(term) >= len(table.TermOffset) {
			return ""
		}
		start := uint64(table.TermOffset[term])
		end := start + uint64(table.TermLength[term])
		if end > uint64(len(table.Units)) {
			return ""
		}
		return string(utf16.Decode(table.Units[start:end]))
	}
	strings := &s.Frozen.Terms
	if int(term)+1 >= len(strings.Offsets) {
		return ""
	}
	start, end := strings.Offsets[term], strings.Offsets[term+1]
	if start > end || int(end) > len(strings.Text) {
		return ""
	}
	return string(strings.Text[start:end])
}

func (s *Segment) postings(term uint32) postingList {
	if s.Growing != nil {
		columns := &s.Growing.Columns
		if int(term) >= len(columns.SliceStart) || columns.Flags[term]&growingTermLive == 0 {
			return postingList{term: term, ordered: true}
		}
		return postingList{
			term:    term,
			start:   columns.SliceStart[term],
			length:  columns.Lengths[term],
			ordered: columns.Flags[term]&growingTermOrdered != 0,
		}
	}
	segment := s.Frozen
	if int(term) >= len(segment.PayloadSlots) {
		return postingList{term: term, ordered: true}
	}
	slot := segment.PayloadSlots[term]
	if int(slot)+1 >= len(segment.PostingOffsets) {
		return postingList{term: term, ordered: true}
	}
	start, end := segment.PostingOffsets[slot], segment.PostingOffsets[slot+1]
	if start > end || int(end) > len(segment.PostingDocuments) {
		return postingList{term: term, ordered: true}
	}
	return postingList{term: term, start: start, length: end - start, ordered: ascending(segment.PostingDocuments[start:end])}
}

func ascending(documents []uint32) bool {
	for at := 1; at < len(documents); at++ {
		if documents[at] < documents[at-1] {
			return false
		}
	}
	return true
}

func (s *Segment) pool() ([]uint32, []uint16, []uint16) {
	if s.Growing != nil {
		pool := &s.Growing.Postings
		return pool.DocIDs, pool.Frequencies, pool.FieldIndices
	}
	return s.Frozen.PostingDocuments, s.Frozen.PostingFrequencies, s.Frozen.PostingFields
}

type termFinder struct {
	units    []uint16
	ordinals []uint32
	counts   []uint32
	single   [1]uint32
}

func (f *termFinder) frequencies(segment *Segment, terms []uint32) ([]uint32, error) {
	if cap(f.counts) < len(terms) {
		f.counts = make([]uint32, len(terms))
	}
	counts := f.counts[:len(terms)]
	if err := core.DocumentFrequencies(segment.dictionary(), terms, counts); err != nil {
		return nil, err
	}
	return counts, nil
}

func (f *termFinder) encode(text string) []uint16 {
	f.units = f.units[:0]
	for _, point := range text {
		if point >= 0x10000 {
			high, low := utf16.EncodeRune(point)
			f.units = append(f.units, uint16(high), uint16(low))
			continue
		}
		f.units = append(f.units, uint16(point))
	}
	return f.units
}

func (f *termFinder) exact(workspace *core.Workspace, segment *Segment, token string) (uint32, bool, error) {
	count, err := workspace.LookupExact(segment.dictionary(), f.encode(token), f.single[:])
	if err != nil || count == 0 {
		return 0, false, err
	}
	return f.single[0], true, nil
}

func (f *termFinder) typo(workspace *core.Workspace, segment *Segment, token string, tolerance, prefixLength uint32) ([]uint32, error) {
	if tolerance == 0 {
		term, found, err := f.exact(workspace, segment, token)
		if err != nil || !found {
			return nil, err
		}
		f.ordinals = append(f.ordinals[:0], term)
		return f.ordinals, nil
	}
	if needed := segment.termCount(); cap(f.ordinals) < needed {
		f.ordinals = make([]uint32, needed)
	}
	ordinals := f.ordinals[:cap(f.ordinals)]
	count, err := workspace.LookupTypo(segment.dictionary(), f.encode(token), tolerance, prefixLength, ordinals)
	if err != nil {
		return nil, err
	}
	return ordinals[:count], nil
}
