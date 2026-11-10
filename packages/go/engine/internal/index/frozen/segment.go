package frozen

import (
	"sort"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fieldindex"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/geo"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partialwords"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/pattern"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/stored"
)

type FieldIndexes struct {
	Numbers   map[string]*fieldindex.Numeric
	Booleans  map[string]*fieldindex.Boolean
	Enums     map[string]*fieldindex.Enum
	Geopoints map[string]*geo.Index
	Sizes     map[string]*fieldindex.Numeric
}

type SurfaceForm struct {
	Surface     string
	Token       string
	Occurrences int
}

type Segment struct {
	documents           []*stored.Document
	ids                 []string
	text                *pagedText
	residentFileBytes   int
	idOrder             []uint32
	idBytes             int
	fieldNames          []string
	tokenText           []byte
	tokenOffsets        []uint32
	documentFrequencies []uint32
	termFrequencies     []float64
	orderedTokens       bitset.Bits
	postingOffsets      []uint32
	postingDocuments    []uint32
	postingFrequencies  []uint16
	postingFields       []uint16
	positionOffsets     []uint32
	positions           []uint32
	lengthNames         []string
	lengthColumns       [][]uint32
	totalFieldLengths   map[string]float64
	indexes             FieldIndexes
	surfaces            []SurfaceForm
	stemTotals          map[string]int
	contentBytes        int
	encodedBytes        int
	staticBytes         int
	partialWords        *partialwords.FrozenTable
	patterns            map[string]*pattern.Frozen
	pagedOrigin         bool
}

func (s *Segment) PagedOrigin() bool {
	return s.pagedOrigin
}

func (s *Segment) WithPagedOrigin() *Segment {
	copied := *s
	copied.pagedOrigin = true
	return &copied
}

func (s *Segment) PartialWords() *partialwords.FrozenTable {
	return s.partialWords
}

func (s *Segment) WithPartialWords(table *partialwords.FrozenTable) *Segment {
	copied := *s
	copied.partialWords = table
	return &copied
}

func (s *Segment) PatternIndex(field string) (*pattern.Frozen, bool) {
	index, found := s.patterns[field]
	return index, found
}

func (s *Segment) PatternFields() []string {
	fields := make([]string, 0, len(s.patterns))
	for field := range s.patterns {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	return fields
}

func (s *Segment) TokenIndex(token string) int {
	at, found := s.FindToken(token)
	if !found {
		return -1
	}
	return at
}

func (s *Segment) DocumentCount() int {
	if s.text != nil {
		return len(s.ids)
	}
	return len(s.documents)
}

func (s *Segment) DocumentAt(ordinal uint32) (*stored.Document, error) {
	if int(ordinal) >= s.DocumentCount() {
		return nil, nil
	}
	if s.text != nil {
		return s.pagedDocument(ordinal)
	}
	return s.documents[ordinal], nil
}

func (s *Segment) HeldDocument(ordinal uint32) *stored.Document {
	if s.text != nil || int(ordinal) >= len(s.documents) {
		return nil
	}
	return s.documents[ordinal]
}

func (s *Segment) IDAt(ordinal uint32) (string, bool) {
	if int(ordinal) >= s.DocumentCount() {
		return "", false
	}
	if s.text != nil {
		return s.ids[ordinal], true
	}
	return s.documents[ordinal].ID, true
}

func (s *Segment) idOf(ordinal uint32) string {
	id, _ := s.IDAt(ordinal)
	return id
}

func (s *Segment) Ordinal(id string) (uint32, bool) {
	at := sort.Search(len(s.idOrder), func(position int) bool { return s.idOf(s.idOrder[position]) >= id })
	if at < len(s.idOrder) && s.idOf(s.idOrder[at]) == id {
		return s.idOrder[at], true
	}
	return 0, false
}

func (s *Segment) SortedOrdinals() []uint32 {
	return s.idOrder
}

func (s *Segment) FieldNames() []string {
	return s.fieldNames
}

func (s *Segment) TokenCount() int {
	return len(s.documentFrequencies)
}

func (s *Segment) tokenBytes(at int) []byte {
	return s.tokenText[s.tokenOffsets[at]:s.tokenOffsets[at+1]]
}

func (s *Segment) TokenAt(at int) string {
	return string(s.tokenBytes(at))
}

func (s *Segment) FindToken(token string) (int, bool) {
	at := sort.Search(s.TokenCount(), func(position int) bool { return string(s.tokenBytes(position)) >= token })
	return at, at < s.TokenCount() && string(s.tokenBytes(at)) == token
}

func (s *Segment) PrefixRange(prefix string) (int, int) {
	start := sort.Search(s.TokenCount(), func(position int) bool { return string(s.tokenBytes(position)) >= prefix })
	end := start
	for end < s.TokenCount() && strings.HasPrefix(string(s.tokenBytes(end)), prefix) {
		end++
	}
	return start, end
}

func (s *Segment) StoredDocumentFrequency(at int) uint32 {
	return s.documentFrequencies[at]
}

func (s *Segment) StoredTermFrequency(at int) float64 {
	return s.termFrequencies[at]
}

func (s *Segment) List(at int, liveDocuments, deadDocuments uint32) (postings.List, error) {
	if s.text != nil {
		return s.pagedList(at, liveDocuments, deadDocuments)
	}
	from, to := s.postingOffsets[at], s.postingOffsets[at+1]
	rows := postings.FrozenRows{
		Start:             from,
		DocIDs:            s.postingDocuments[from:to:to],
		Frequencies:       s.postingFrequencies[from:to:to],
		Fields:            s.postingFields[from:to:to],
		Ordered:           s.orderedTokens.Has(uint32(at)),
		DocumentFrequency: liveDocuments,
		DeadDocuments:     deadDocuments,
	}
	if s.positionOffsets != nil {
		rows.PositionOffsets = s.positionOffsets[from : to+1 : to+1]
		rows.Positions = s.positions
	}
	return postings.FrozenList(rows), nil
}

func (s *Segment) Pool() postings.Pool {
	return postings.Pool{DocIDs: s.postingDocuments, Frequencies: s.postingFrequencies, Fields: s.postingFields}
}

func (s *Segment) TracksPositions() bool {
	if s.text != nil {
		return s.text.tracksPositions
	}
	return s.positionOffsets != nil
}

func (s *Segment) LengthNames() []string {
	return s.lengthNames
}

func (s *Segment) LengthColumn(field string) []uint32 {
	for at, name := range s.lengthNames {
		if name == field {
			return s.lengthColumns[at]
		}
	}
	return nil
}

func (s *Segment) TotalFieldLengths() map[string]float64 {
	return s.totalFieldLengths
}

func (s *Segment) Indexes() FieldIndexes {
	return s.indexes
}

func (s *Segment) Surfaces() []SurfaceForm {
	return s.surfaces
}

func (s *Segment) SurfacesWithPrefix(prefix string) []SurfaceForm {
	start := sort.Search(len(s.surfaces), func(at int) bool { return s.surfaces[at].Surface >= prefix })
	end := start
	for end < len(s.surfaces) && strings.HasPrefix(s.surfaces[end].Surface, prefix) {
		end++
	}
	return s.surfaces[start:end]
}

func (s *Segment) StemChangedTotal(token string) int {
	return s.stemTotals[token]
}

func (s *Segment) ContentBytes() int {
	return s.contentBytes
}
