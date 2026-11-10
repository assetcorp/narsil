package query

import (
	"encoding/binary"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	pagedDocumentBytes  = 4
	pagedFrequencyBytes = 2
	pagedFieldBytes     = 2
	pagedPostingBytes   = pagedDocumentBytes + pagedFrequencyBytes + pagedFieldBytes
)

type pagedPool struct {
	segment     *Segment
	documents   []uint32
	frequencies []uint16
	fields      []uint16
	lists       map[uint32]postingList
	bytes       []byte
}

func (p *pagedPool) reset(segment *Segment) {
	p.segment = segment
	p.documents, p.frequencies, p.fields = p.documents[:0], p.frequencies[:0], p.fields[:0]
	if p.lists == nil {
		p.lists = map[uint32]postingList{}
	}
	clear(p.lists)
}

func (s *searcher) pagedPhrasePostings(segment *Segment, term uint32, found bool) (core.PhrasePostings, error) {
	if !found {
		return core.PhrasePostings{Ordered: true}, nil
	}
	list, err := s.postingsOf(segment, term)
	if err != nil {
		return core.PhrasePostings{}, err
	}
	offsets, values, held, err := segment.Paged.ReadPositions(term)
	if err != nil {
		return core.PhrasePostings{}, narsilerr.Passthrough(err, narsilerr.CodePartitionCorrupted, "The positions of a paged segment could not be read")
	}
	if !held || len(offsets) != int(list.length)+1 {
		return core.PhrasePostings{Ordered: true}, nil
	}
	documents, _, fields := s.poolOf(segment)
	end := list.start + list.length
	postings := core.PhrasePostings{
		Documents:      documents[list.start:end],
		Fields:         fields[list.start:end],
		PositionStarts: offsets[:list.length],
		PositionCounts: make([]uint32, list.length),
		Positions:      values,
		Ordered:        list.ordered,
	}
	for row := range list.length {
		postings.PositionCounts[row] = offsets[row+1] - offsets[row]
	}
	return postings, nil
}

func (s *searcher) postingsOf(segment *Segment, term uint32) (postingList, error) {
	if segment.Paged == nil {
		return segment.postings(term), nil
	}
	pool := &s.paged
	if pool.segment != segment {
		pool.reset(segment)
	}
	if list, held := pool.lists[term]; held {
		return list, nil
	}
	offsets := segment.Frozen.PostingOffsets
	if uint64(term)+1 >= uint64(len(offsets)) || offsets[term] > offsets[term+1] {
		return postingList{term: term, ordered: true}, nil
	}
	count := int(offsets[term+1] - offsets[term])
	if need := count * pagedPostingBytes; cap(pool.bytes) < need {
		pool.bytes = make([]byte, need)
	}
	read, err := segment.Paged.ReadPostings(s.workspace, term, pool.bytes[:count*pagedPostingBytes])
	if err != nil {
		return postingList{}, narsilerr.Passthrough(err, narsilerr.CodePartitionCorrupted, "The postings of a paged segment could not be read")
	}
	if read != count {
		return postingList{}, narsilerr.New(narsilerr.CodePartitionCorrupted, "A paged segment returned a posting count its offsets do not hold", nil)
	}
	bytes := pool.bytes[:count*pagedPostingBytes]
	frequencies := bytes[count*pagedDocumentBytes:]
	fields := frequencies[count*pagedFrequencyBytes:]
	start := uint32(len(pool.documents))
	for at := range count {
		pool.documents = append(pool.documents, binary.LittleEndian.Uint32(bytes[at*pagedDocumentBytes:]))
		pool.frequencies = append(pool.frequencies, binary.LittleEndian.Uint16(frequencies[at*pagedFrequencyBytes:]))
		pool.fields = append(pool.fields, binary.LittleEndian.Uint16(fields[at*pagedFieldBytes:]))
	}
	list := postingList{term: term, start: start, length: uint32(count), ordered: ascending(pool.documents[start:])}
	pool.lists[term] = list
	return list, nil
}

func (s *searcher) poolOf(segment *Segment) ([]uint32, []uint16, []uint16) {
	if segment.Paged == nil {
		return segment.pool()
	}
	if s.paged.segment != segment {
		s.paged.reset(segment)
	}
	return s.paged.documents, s.paged.frequencies, s.paged.fields
}
