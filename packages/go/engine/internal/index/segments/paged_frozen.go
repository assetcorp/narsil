package segments

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
)

func (p *Paged) fieldColumnsFile() *keyword.Segment {
	resident := &p.reader.Resident
	return &keyword.Segment{DocumentCount: p.reader.Head.DocumentCount, Numeric: resident.Numeric,
		Sizes: resident.Sizes, Boolean: resident.Boolean, Enum: resident.Enum, Geopoint: resident.Geopoint,
		Pattern: resident.Pattern}
}

func (p *Paged) holdFieldIndexes(w *core.Workspace) error {
	if p.reader.Head.DocumentCount == 0 {
		return nil
	}
	derived, err := derivedFieldIndexes(w, p.fieldColumnsFile())
	if err != nil {
		return err
	}
	p.Fields = derived
	return nil
}

func (p *Paged) FieldSchema() map[string]string {
	return p.reader.Head.Schema
}

func (p *Paged) Tombstones() []string {
	return p.reader.Head.Tombstones
}

func (p *Paged) IDs() ([]string, error) {
	ids := make([]string, p.reader.Head.DocumentCount)
	for ordinal := range ids {
		id, err := p.reader.IDBytes(uint32(ordinal))
		if err != nil {
			return nil, err
		}
		ids[ordinal] = string(id)
	}
	return ids, nil
}

func (p *Paged) DocumentAt(ordinal uint32) ([]byte, error) {
	return p.reader.EncodedDocument(ordinal)
}

type residentPostings struct {
	documents       []uint32
	frequencies     []uint16
	fields          []uint16
	positionOffsets []uint32
	positions       []uint32
}

func (p *Paged) residentPostings() (residentPostings, error) {
	tracks := p.reader.Resident.TracksPositions
	held := residentPostings{positionOffsets: []uint32{0}}
	for token := range p.reader.TokenCount() {
		rows, err := p.reader.Rows(token)
		if err != nil {
			return residentPostings{}, err
		}
		held.documents = append(held.documents, rows.Documents...)
		held.frequencies = append(held.frequencies, rows.Frequencies...)
		held.fields = append(held.fields, rows.Fields...)
		if !tracks {
			continue
		}
		first := uint32(len(held.positions))
		for row := range rows.Documents {
			held.positionOffsets = append(held.positionOffsets, first+rows.PositionOffsets[row+1])
		}
		held.positions = append(held.positions, rows.Positions...)
	}
	return held, nil
}

func (p *Paged) Resident(w *core.Workspace) (*Frozen, error) {
	postings, err := p.residentPostings()
	if err != nil {
		return nil, err
	}
	surfaces, err := p.reader.SurfaceForms()
	if err != nil {
		return nil, err
	}
	resident := &p.reader.Resident
	file := p.fieldColumnsFile()
	file.FieldNames = p.reader.Head.FieldNames
	file.Tokens, file.TokenOffsets = resident.Tokens, resident.TokenOffsets
	file.DocumentFrequencies, file.PostingOffsets = resident.DocumentFrequencies, resident.PostingOffsets
	file.PostingDocuments = uint32Column(postings.documents)
	file.PostingFrequencies = uint16Column(postings.frequencies)
	file.PostingFields = uint16Column(postings.fields)
	file.FieldLengths, file.SurfaceForms, file.PartialWords = resident.FieldLengths, surfaces, resident.PartialWords
	if resident.TracksPositions {
		file.TracksPositions = true
		file.PositionOffsets = uint32Column(postings.positionOffsets)
		file.Positions = uint32Column(postings.positions)
	}
	return OpenKeywordFile(w, file)
}
