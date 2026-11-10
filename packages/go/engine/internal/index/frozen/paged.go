package frozen

import (
	"runtime"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/postings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/stored"
)

type DocumentSettler func(ordinal uint32, id string, fields map[string]any) *stored.Document

type pagedText struct {
	reader          *paged.Reader
	fileTokens      []uint32
	tracksPositions bool
	settle          DocumentSettler
	path            string
}

type PagedToken struct {
	Token     string
	File      uint32
	Documents uint32
	Frequency float64
	Ordered   bool
}

type PagedParts struct {
	Reader          *paged.Reader
	Release         func()
	Path            string
	IDs             []string
	FieldNames      []string
	TracksPositions bool
	Tokens          []PagedToken
	Settle          DocumentSettler
	ContentBytes    int
	ResidentBytes   int
	Parts           Parts
}

func releasePagedText(release func()) {
	release()
}

func NewPaged(parts PagedParts) *Segment {
	tokens := append([]PagedToken(nil), parts.Tokens...)
	sort.Slice(tokens, func(left, right int) bool { return tokens[left].Token < tokens[right].Token })
	text := &pagedText{reader: parts.Reader, tracksPositions: parts.TracksPositions, settle: parts.Settle, path: parts.Path}
	if parts.Release != nil {
		runtime.AddCleanup(text, releasePagedText, parts.Release)
	}
	segment := &Segment{
		ids:                 parts.IDs,
		text:                text,
		fieldNames:          parts.FieldNames,
		tokenOffsets:        make([]uint32, len(tokens)+1),
		documentFrequencies: make([]uint32, len(tokens)),
		termFrequencies:     make([]float64, len(tokens)),
		orderedTokens:       bitset.New(len(tokens)),
		lengthNames:         parts.Parts.LengthNames,
		lengthColumns:       parts.Parts.LengthColumns,
		indexes:             parts.Parts.Indexes,
		surfaces:            sortedSurfaces(parts.Parts.Surfaces),
		contentBytes:        parts.ContentBytes,
		residentFileBytes:   parts.ResidentBytes,
	}
	identity := true
	textBytes := 0
	for at, pending := range tokens {
		textBytes += len(pending.Token)
		identity = identity && pending.File == uint32(at)
	}
	if !identity {
		text.fileTokens = make([]uint32, len(tokens))
	}
	segment.tokenText = make([]byte, 0, textBytes)
	for at, pending := range tokens {
		segment.tokenText = append(segment.tokenText, pending.Token...)
		segment.tokenOffsets[at+1] = uint32(len(segment.tokenText))
		segment.documentFrequencies[at] = pending.Documents
		segment.termFrequencies[at] = pending.Frequency
		if pending.Ordered {
			segment.orderedTokens.Set(uint32(at))
		}
		if text.fileTokens != nil {
			text.fileTokens[at] = pending.File
		}
	}
	segment.settleOrder()
	segment.finishParts(parts.Parts)
	return segment
}

func (s *Segment) HoldsTextOnDisk() bool {
	return s.text != nil
}

func (s *Segment) TextFilePath() (string, bool) {
	if s.text == nil {
		return "", false
	}
	return s.text.path, true
}

func (t *pagedText) fileToken(at int) int {
	if t.fileTokens == nil {
		return at
	}
	return int(t.fileTokens[at])
}

func (s *Segment) pagedList(at int, liveDocuments, deadDocuments uint32) (postings.List, error) {
	rows, err := s.text.reader.Rows(s.text.fileToken(at))
	runtime.KeepAlive(s.text)
	if err != nil {
		return postings.List{}, err
	}
	frozenRows := postings.FrozenRows{
		DocIDs:            rows.Documents,
		Frequencies:       rows.Frequencies,
		Fields:            rows.Fields,
		Ordered:           s.orderedTokens.Has(uint32(at)),
		DocumentFrequency: liveDocuments,
		DeadDocuments:     deadDocuments,
		Detached:          true,
	}
	if s.text.tracksPositions {
		frozenRows.PositionOffsets = rows.PositionOffsets
		frozenRows.Positions = rows.Positions
	}
	return postings.FrozenList(frozenRows), nil
}

func (s *Segment) pagedDocument(ordinal uint32) (*stored.Document, error) {
	fields, err := s.text.reader.Document(ordinal)
	runtime.KeepAlive(s.text)
	if err != nil {
		return nil, err
	}
	return s.text.settle(ordinal, s.ids[ordinal], fields), nil
}
