package frozen

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partialwords"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/pattern"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/stored"
)

type pendingToken struct {
	token     string
	from      uint32
	to        uint32
	documents uint32
	frequency float64
	ordered   bool
}

type Builder struct {
	documents       []*stored.Document
	fieldNames      []string
	tracksPositions bool
	tokens          []pendingToken
	docIDs          []uint32
	frequencies     []uint16
	fields          []uint16
	positionStarts  []uint32
	positions       []uint32
	lastToken       []uint32
}

type Parts struct {
	LengthNames      []string
	LengthColumns    [][]uint32
	Indexes          FieldIndexes
	Surfaces         []SurfaceForm
	PartialSpellings *partialwords.EncodedSpellings
	Patterns         []pattern.Arrays
}

func NewBuilder(documents []*stored.Document, fieldNames []string, tracksPositions bool) *Builder {
	return &Builder{
		documents:       documents,
		fieldNames:      fieldNames,
		tracksPositions: tracksPositions,
		lastToken:       make([]uint32, len(documents)),
	}
}

func (b *Builder) BeginToken(token string) {
	b.closeToken()
	at := uint32(len(b.docIDs))
	b.tokens = append(b.tokens, pendingToken{token: token, from: at, to: at, ordered: true})
}

func (b *Builder) closeToken() {
	if len(b.tokens) == 0 {
		return
	}
	last := &b.tokens[len(b.tokens)-1]
	last.to = uint32(len(b.docIDs))
	if last.to == last.from {
		b.tokens = b.tokens[:len(b.tokens)-1]
	}
}

func (b *Builder) AddRow(ordinal uint32, frequency, field uint16, positions []uint32) {
	current := &b.tokens[len(b.tokens)-1]
	marker := uint32(len(b.tokens))
	if b.lastToken[ordinal] != marker {
		b.lastToken[ordinal] = marker
		current.documents++
	}
	if row := len(b.docIDs); row > int(current.from) && ordinal < b.docIDs[row-1] {
		current.ordered = false
	}
	b.docIDs = append(b.docIDs, ordinal)
	b.frequencies = append(b.frequencies, frequency)
	b.fields = append(b.fields, field)
	current.frequency += float64(frequency)
	if b.tracksPositions {
		b.positionStarts = append(b.positionStarts, uint32(len(b.positions)))
		b.positions = append(b.positions, positions...)
	}
}

func (b *Builder) Finish(parts Parts) *Segment {
	b.closeToken()
	sort.Slice(b.tokens, func(left, right int) bool { return b.tokens[left].token < b.tokens[right].token })
	segment := &Segment{
		documents:           b.documents,
		fieldNames:          b.fieldNames,
		tokenOffsets:        make([]uint32, len(b.tokens)+1),
		documentFrequencies: make([]uint32, len(b.tokens)),
		termFrequencies:     make([]float64, len(b.tokens)),
		orderedTokens:       bitset.New(len(b.tokens)),
		postingOffsets:      make([]uint32, len(b.tokens)+1),
		postingDocuments:    make([]uint32, 0, len(b.docIDs)),
		postingFrequencies:  make([]uint16, 0, len(b.docIDs)),
		postingFields:       make([]uint16, 0, len(b.docIDs)),
		lengthNames:         parts.LengthNames,
		lengthColumns:       parts.LengthColumns,
		indexes:             parts.Indexes,
		surfaces:            sortedSurfaces(parts.Surfaces),
	}
	textBytes := 0
	for _, pending := range b.tokens {
		textBytes += len(pending.token)
	}
	segment.tokenText = make([]byte, 0, textBytes)
	if b.tracksPositions {
		segment.positionOffsets = make([]uint32, 1, len(b.docIDs)+1)
		segment.positions = make([]uint32, 0, len(b.positions))
	}
	for at, pending := range b.tokens {
		segment.tokenText = append(segment.tokenText, pending.token...)
		segment.tokenOffsets[at+1] = uint32(len(segment.tokenText))
		segment.documentFrequencies[at] = pending.documents
		segment.termFrequencies[at] = pending.frequency
		if pending.ordered {
			segment.orderedTokens.Set(uint32(at))
		}
		segment.postingDocuments = append(segment.postingDocuments, b.docIDs[pending.from:pending.to]...)
		segment.postingFrequencies = append(segment.postingFrequencies, b.frequencies[pending.from:pending.to]...)
		segment.postingFields = append(segment.postingFields, b.fields[pending.from:pending.to]...)
		segment.postingOffsets[at+1] = uint32(len(segment.postingDocuments))
		if b.tracksPositions {
			for row := pending.from; row < pending.to; row++ {
				end := uint32(len(b.positions))
				if int(row)+1 < len(b.positionStarts) {
					end = b.positionStarts[row+1]
				}
				segment.positions = append(segment.positions, b.positions[b.positionStarts[row]:end]...)
				segment.positionOffsets = append(segment.positionOffsets, uint32(len(segment.positions)))
			}
		}
	}
	segment.settleOrder()
	segment.settleDocumentBytes()
	segment.finishParts(parts)
	return segment
}

func (s *Segment) finishParts(parts Parts) {
	if parts.PartialSpellings != nil {
		s.partialWords = partialwords.BuildFrozenTable(*parts.PartialSpellings, s.TokenIndex)
	}
	if len(parts.Patterns) > 0 {
		s.patterns = make(map[string]*pattern.Frozen, len(parts.Patterns))
		for _, arrays := range parts.Patterns {
			s.patterns[arrays.Field] = pattern.NewFrozen(arrays)
		}
	}
	s.staticBytes = s.measureStaticBytes()
}

func sortedSurfaces(forms []SurfaceForm) []SurfaceForm {
	kept := make([]SurfaceForm, 0, len(forms))
	for _, form := range forms {
		if form.Occurrences > 0 {
			kept = append(kept, form)
		}
	}
	sort.Slice(kept, func(left, right int) bool { return kept[left].Surface < kept[right].Surface })
	return kept
}

func (s *Segment) settleOrder() {
	s.idOrder = make([]uint32, s.DocumentCount())
	for ordinal := range s.idOrder {
		s.idOrder[ordinal] = uint32(ordinal)
	}
	sort.Slice(s.idOrder, func(left, right int) bool {
		return s.idOf(s.idOrder[left]) < s.idOf(s.idOrder[right])
	})
	for ordinal := range s.idOrder {
		s.idBytes += len(s.idOf(uint32(ordinal)))
	}
	s.totalFieldLengths = make(map[string]float64, len(s.lengthNames))
	for at, name := range s.lengthNames {
		total := 0.0
		for _, length := range s.lengthColumns[at] {
			total += float64(length)
		}
		s.totalFieldLengths[name] = total
	}
	s.stemTotals = make(map[string]int, len(s.surfaces))
	for _, form := range s.surfaces {
		s.stemTotals[form.Token] += form.Occurrences
	}
}

func (s *Segment) settleDocumentBytes() {
	for _, document := range s.documents {
		s.contentBytes += document.ContentBytes
		if encoded, err := codec.EncodeDocument(document.Fields); err == nil {
			s.encodedBytes += len(encoded)
		}
	}
}
