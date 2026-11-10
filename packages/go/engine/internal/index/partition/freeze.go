package partition

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/frozen"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func indexesOf(documents []*StoredDocument, fields []schema.Field) frozen.FieldIndexes {
	scratch := newSide()
	valueFields := make([]schema.Field, len(fields))
	for at, field := range fields {
		valueFields[at] = field
		valueFields[at].Pattern = false
	}
	for ordinal, document := range documents {
		scratch.indexValues(uint32(ordinal), document.Fields, valueFields)
	}
	scratch.settle()
	return frozen.FieldIndexes{Numbers: scratch.numbers, Booleans: scratch.booleans, Enums: scratch.enums, Geopoints: scratch.geopoints, Sizes: scratch.sizes}
}

func (s *side) tailHoldsPositions() bool {
	holds := false
	s.postings.ForEachToken(func(token string) bool {
		list, found := s.postings.Lookup(token)
		holds = found && list.HoldsPositions()
		return !holds
	})
	return holds
}

func (s *side) frozenTail(fields []schema.Field) *frozen.Segment {
	remap := make([]int32, s.documents.capacity())
	documents := make([]*StoredDocument, 0, s.documents.count)
	for ordinal := range remap {
		remap[ordinal] = -1
		if document := s.documents.at(uint32(ordinal)); document != nil {
			remap[ordinal] = int32(len(documents))
			documents = append(documents, document)
		}
	}
	builder := frozen.NewBuilder(documents, append([]string(nil), s.fieldNames...), s.tailHoldsPositions())
	s.postings.ForEachToken(func(token string) bool {
		list, found := s.postings.Lookup(token)
		if !found {
			return true
		}
		builder.BeginToken(token)
		for row, ordinal := range list.DocIDs {
			if list.DeadDocuments > 0 && s.postings.IsRetired(ordinal) || int(ordinal) >= len(remap) || remap[ordinal] < 0 {
				continue
			}
			builder.AddRow(uint32(remap[ordinal]), list.Frequencies[row], list.Fields[row], list.PositionsAt(row))
		}
		return true
	})
	names := make([]string, 0, len(s.statistics.totalFieldLengths))
	for field := range s.statistics.totalFieldLengths {
		names = append(names, field)
	}
	sort.Strings(names)
	columns := make([][]uint32, len(names))
	for at, field := range names {
		column := make([]uint32, len(documents))
		source := s.documents.lengthColumns[field]
		for ordinal, target := range remap {
			if target >= 0 && ordinal < len(source) {
				column[target] = source[ordinal]
			}
		}
		columns[at] = column
	}
	surfaces := make([]frozen.SurfaceForm, 0, len(s.surfaces.entries))
	for surface, entry := range s.surfaces.entries {
		surfaces = append(surfaces, frozen.SurfaceForm{Surface: surface, Token: entry.token, Occurrences: entry.count})
	}
	parts := frozen.Parts{LengthNames: names, LengthColumns: columns, Indexes: indexesOf(documents, fields), Surfaces: surfaces,
		Patterns: s.frozenPatterns(remap)}
	if encoded, held := s.partial.Encode(); held {
		parts.PartialSpellings = &encoded
	}
	return builder.Finish(parts)
}

func (p *Partition) FreezeLiveTail(minimumDocuments int) bool {
	p.pair.writer.Lock()
	defer p.pair.writer.Unlock()
	active := p.pair.activeState()
	if active.documents.count == 0 || active.documents.count < minimumDocuments {
		return false
	}
	segment := active.frozenTail(p.fields)
	p.pair.publish([]operation{{kind: freezeTail, segment: segment}})
	return true
}

func (p *Partition) AttachFrozenSegment(segment *frozen.Segment, tombstonedIDs []string) error {
	if segment == nil {
		return nil
	}
	analysed, err := p.analysisFor(false)
	if err != nil {
		return err
	}
	tombstoned := map[string]struct{}{}
	for _, id := range tombstonedIDs {
		tombstoned[id] = struct{}{}
	}
	isTombstoned := func(ordinal int) bool {
		id, _ := segment.IDAt(uint32(ordinal))
		_, removed := tombstoned[id]
		return removed
	}
	segment, rebuilt, err := p.withPartialTable(segment, isTombstoned, analysed.Pass)
	if err != nil {
		return err
	}
	var carried []carriedTombstone
	for ordinal := range segment.DocumentCount() {
		id, _ := segment.IDAt(uint32(ordinal))
		if _, removed := tombstoned[id]; !removed {
			continue
		}
		document, err := segment.DocumentAt(uint32(ordinal))
		if err != nil {
			return err
		}
		text, err := p.carriedText(segment, document, analysed, !rebuilt)
		if err != nil {
			return err
		}
		carried = append(carried, carriedTombstone{ordinal: uint32(ordinal), text: text})
	}
	p.pair.writer.Lock()
	defer p.pair.writer.Unlock()
	active := p.pair.activeState()
	for ordinal := range segment.DocumentCount() {
		id, _ := segment.IDAt(uint32(ordinal))
		if _, removed := tombstoned[id]; removed {
			continue
		}
		if active.locate(id).found() {
			return alreadyExists(id, p.id)
		}
	}
	p.pair.publish([]operation{{kind: swapSegments, segment: segment, carried: carried}})
	return nil
}
