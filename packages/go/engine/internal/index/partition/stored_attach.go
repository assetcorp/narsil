package partition

import (
	"sort"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/frozen"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type StoredLengthColumn struct {
	Field   string
	Lengths []uint32
}

type StoredSegment struct {
	Documents       []Document
	FieldNames      []string
	TracksPositions bool
	PagedOrigin     bool
	LengthColumns   []StoredLengthColumn
	Surfaces        []frozen.SurfaceForm
	TokenCount      int
	Token           func(at int) string
	VisitRows       func(at int, add func(ordinal uint32, frequency, field uint16, positions []uint32)) error
}

func storedSegmentBroken(message string, partitionID int) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, message, map[string]any{"partitionId": partitionID})
}

func (p *Partition) storedDocuments(stored StoredSegment, columns map[string][]uint32) []*StoredDocument {
	documents := make([]*StoredDocument, len(stored.Documents))
	for ordinal, document := range stored.Documents {
		lengths := map[string]uint32{}
		for _, field := range p.fields {
			if !field.IsWordIndexed() {
				continue
			}
			if _, present := presentValue(document.Fields, field.Path); !present {
				continue
			}
			if column := columns[field.Path]; ordinal < len(column) {
				lengths[field.Path] = column[ordinal]
			} else {
				lengths[field.Path] = 0
			}
		}
		documents[ordinal] = storedFrom(document, lengths)
	}
	return documents
}

func (p *Partition) storedLengths(stored StoredSegment) ([]string, [][]uint32, map[string][]uint32, error) {
	byName := make(map[string][]uint32, len(stored.LengthColumns))
	for _, column := range stored.LengthColumns {
		if len(column.Lengths) != len(stored.Documents) {
			return nil, nil, nil, storedSegmentBroken("A stored segment gives field \""+column.Field+
				"\" a length column of another size than its document count", p.id)
		}
		byName[column.Field] = column.Lengths
	}
	names := make([]string, 0, len(byName))
	for name := range byName {
		names = append(names, name)
	}
	sort.Strings(names)
	columns := make([][]uint32, len(names))
	for at, name := range names {
		columns[at] = byName[name]
	}
	return names, columns, byName, nil
}

func (p *Partition) storedRows(builder *frozen.Builder, stored StoredSegment, documentCount int) error {
	fieldCount := len(stored.FieldNames)
	var broken error
	for at := range stored.TokenCount {
		builder.BeginToken(stored.Token(at))
		err := stored.VisitRows(at, func(ordinal uint32, frequency, field uint16, positions []uint32) {
			if broken != nil {
				return
			}
			if int(ordinal) >= documentCount || int(field) >= fieldCount {
				broken = storedSegmentBroken("Token "+strconv.Itoa(at)+
					" of a stored segment names a document or field outside the segment", p.id)
				return
			}
			builder.AddRow(ordinal, frequency, field, positions)
		})
		if err != nil {
			return err
		}
		if broken != nil {
			return broken
		}
	}
	return nil
}

func (p *Partition) storedValueParts(documents []*StoredDocument) (frozen.FieldIndexes, *side) {
	scratch := newSide()
	for ordinal, document := range documents {
		scratch.indexValues(uint32(ordinal), document.Fields, p.fields)
	}
	scratch.settle()
	return frozen.FieldIndexes{Numbers: scratch.numbers, Booleans: scratch.booleans, Enums: scratch.enums,
		Geopoints: scratch.geopoints, Sizes: scratch.sizes}, scratch
}

func (p *Partition) AttachStoredSegment(stored StoredSegment) error {
	if len(stored.Documents) == 0 {
		return nil
	}
	names, columns, byName, err := p.storedLengths(stored)
	if err != nil {
		return err
	}
	documents := p.storedDocuments(stored, byName)
	builder := frozen.NewBuilder(documents, append([]string(nil), stored.FieldNames...), stored.TracksPositions)
	if err := p.storedRows(builder, stored, len(documents)); err != nil {
		return err
	}
	indexes, scratch := p.storedValueParts(documents)
	identity := make([]int32, len(documents))
	for ordinal := range identity {
		identity[ordinal] = int32(ordinal)
	}
	segment := builder.Finish(frozen.Parts{LengthNames: names, LengthColumns: columns, Indexes: indexes,
		Surfaces: stored.Surfaces, Patterns: scratch.frozenPatterns(identity)})
	if stored.PagedOrigin {
		segment = segment.WithPagedOrigin()
	}
	return p.AttachFrozenSegment(segment, nil)
}
