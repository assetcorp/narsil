package segment

import (
	"context"
	"io"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func lengthColumnsOf(segment *keyword.Segment) [][]uint32 {
	byField := map[string]keyword.Uint32s{}
	for _, column := range segment.FieldLengths {
		byField[column.Field] = column.Lengths
	}
	columns := make([][]uint32, len(segment.FieldNames))
	for at, name := range segment.FieldNames {
		held, present := byField[name]
		if !present {
			continue
		}
		values := make([]uint32, held.Len())
		for ordinal := range values {
			values[ordinal] = held.At(ordinal)
		}
		columns[at] = values
	}
	return columns
}

func rowsOfToken(segment *keyword.Segment, token int) *tokenRows {
	from, to := int(segment.PostingOffsets.At(token)), int(segment.PostingOffsets.At(token+1))
	rows := &tokenRows{starts: make([]uint32, 0, to-from+1)}
	for row := from; row < to; row++ {
		rows.documents = append(rows.documents, segment.PostingDocuments.At(row))
		rows.frequencies = append(rows.frequencies, segment.PostingFrequencies.At(row))
		rows.fields = append(rows.fields, segment.PostingFields.At(row))
		rows.starts = append(rows.starts, uint32(len(rows.positions)))
		if segment.TracksPositions {
			for at := segment.PositionOffsets.At(row); at < segment.PositionOffsets.At(row+1); at++ {
				rows.positions = append(rows.positions, segment.Positions.At(int(at)))
			}
		}
	}
	rows.starts = append(rows.starts, uint32(len(rows.positions)))
	if !rows.ordered() {
		rows.sortByDocumentAndField()
	}
	return rows
}

func (rows *tokenRows) sortByDocumentAndField() {
	order := make([]int, len(rows.documents))
	for at := range order {
		order[at] = at
	}
	sort.SliceStable(order, func(left, right int) bool {
		a, b := order[left], order[right]
		if rows.documents[a] != rows.documents[b] {
			return rows.documents[a] < rows.documents[b]
		}
		return rows.fields[a] < rows.fields[b]
	})
	sorted := &tokenRows{starts: make([]uint32, 0, len(order)+1)}
	for _, from := range order {
		sorted.documents = append(sorted.documents, rows.documents[from])
		sorted.frequencies = append(sorted.frequencies, rows.frequencies[from])
		sorted.fields = append(sorted.fields, rows.fields[from])
		sorted.starts = append(sorted.starts, uint32(len(sorted.positions)))
		sorted.positions = append(sorted.positions, rows.positions[rows.starts[from]:rows.starts[from+1]]...)
	}
	sorted.starts = append(sorted.starts, uint32(len(sorted.positions)))
	*rows = *sorted
}

func idSampleOf(segment *keyword.Segment) []paged.IDSampleEntry {
	var sample []paged.IDSampleEntry
	for position := range segment.IDOrder.Len() {
		if position%paged.IDSampleInterval == 0 {
			sample = append(sample, paged.IDSampleEntry{ID: segment.ID(int(segment.IDOrder.At(position))),
				Position: uint32(position)})
		}
	}
	return sample
}

func surfacesOrNil(segment *keyword.Segment) *keyword.SurfaceFormColumn {
	if segment.SurfaceForms == nil || segment.SurfaceForms.Counts.Len() == 0 {
		return nil
	}
	return segment.SurfaceForms
}

type pagedStream struct {
	scratchPath string
	sinks       []*sectionSink
	removals    *removalSpill
}

func (stream *pagedStream) sink(name string) (*sectionSink, error) {
	opened, err := openSectionSink(stream.scratchPath, name)
	if err != nil {
		return nil, err
	}
	stream.sinks = append(stream.sinks, opened)
	return opened, nil
}

func (stream *pagedStream) discard() {
	for _, sink := range stream.sinks {
		sink.scratch.discard()
	}
	if stream.removals != nil {
		stream.removals.discard()
	}
}

func (stream *pagedStream) writeDocuments(built *keyword.Segment) ([]byte, *sectionSink, error) {
	documents, err := stream.sink("documents")
	if err != nil {
		return nil, nil, err
	}
	writer := paged.NewDocumentBlockWriter(documents.write)
	for ordinal := range int(built.DocumentCount) {
		from, to := built.DocumentOffsets.At(ordinal), built.DocumentOffsets.At(ordinal+1)
		if err := writer.Add(built.Documents[from:to]); err != nil {
			return nil, nil, err
		}
	}
	blocks, err := writer.Finish()
	return blocks, documents, err
}

func (stream *pagedStream) writeRemovals() (*sectionSink, *sectionSink, error) {
	offsets, err := stream.sink("removalOffsets")
	if err != nil {
		return nil, nil, err
	}
	values, err := stream.sink("removals")
	if err != nil {
		return nil, nil, err
	}
	err = stream.removals.drain(func(offsetBytes []byte, valueBytes []byte) error {
		if err := offsets.write(offsetBytes); err != nil {
			return err
		}
		return values.write(valueBytes)
	})
	return offsets, values, err
}

func sinkSources(sinks ...*sectionSink) ([]paged.SectionSource, error) {
	sources := make([]paged.SectionSource, 0, len(sinks))
	for _, sink := range sinks {
		if sink == nil {
			continue
		}
		source, err := sink.source()
		if err != nil {
			return nil, err
		}
		sources = append(sources, source)
	}
	return sources, nil
}

func (stream *pagedStream) sources(ctx context.Context, built *keyword.Segment) ([]paged.SectionSource, error) {
	lists, err := stream.writeLists(ctx, built)
	if err != nil {
		return nil, err
	}
	documentBlocks, documents, err := stream.writeDocuments(built)
	if err != nil {
		return nil, err
	}
	removalOffsets, removalValues, err := stream.writeRemovals()
	if err != nil {
		return nil, err
	}
	resident, err := paged.ResidentSources(paged.ResidentColumns{Tokens: built.Tokens, TokenOffsets: built.TokenOffsets,
		DocumentFrequencies: lists.documentFrequencies, PostingOffsets: lists.postingOffsets,
		BlockLists: lists.blockLists, BlockListOffsets: lists.blockListOffsets, BlockSummaries: lists.blockSummaries,
		FieldLengths: built.FieldLengths, Numeric: built.Numeric, Sizes: built.Sizes, Boolean: built.Boolean,
		Enum: built.Enum, Geopoint: built.Geopoint, Pattern: built.Pattern, PartialWords: built.PartialWords,
		IDSample: idSampleOf(built)}, documentBlocks)
	if err != nil {
		return nil, err
	}
	listed, err := sinkSources(lists.postings, lists.tokenTotals, lists.positionOffsets, lists.positions, documents)
	if err != nil {
		return nil, err
	}
	removals, err := sinkSources(removalOffsets, removalValues)
	if err != nil {
		return nil, err
	}
	sources := append(resident, listed...)
	sources = append(sources, paged.BytesSection("ids", built.IDs), paged.BytesSection("idOffsets", built.IDOffsets),
		paged.BytesSection("idOrder", built.IDOrder))
	sources = append(sources, removals...)
	if built.HasWriteRecords {
		sources = append(sources, paged.BytesSection("seqNos", built.SeqNos),
			paged.BytesSection("primaryTerms", built.PrimaryTerms))
	}
	if surfaces := surfacesOrNil(built); surfaces != nil {
		sources = append(sources, paged.SurfaceFormSource(surfaces))
	}
	return sources, nil
}

func WritePaged(ctx context.Context, writer io.Writer, scratchPath string, built *keyword.Segment) (keyword.Written,
	error) {
	if err := built.Validate(); err != nil {
		return keyword.Written{}, narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed,
			"The paged keyword segment breaks a rule of its format, so it cannot be written", err, nil)
	}
	stream := &pagedStream{scratchPath: scratchPath}
	defer stream.discard()
	sources, err := stream.sources(ctx, built)
	if err != nil {
		return keyword.Written{}, err
	}
	return paged.WriteSegment(writer, paged.HeadFields{Schema: built.Schema, Tombstones: built.Tombstones,
		DocumentCount: built.DocumentCount, FieldNames: built.FieldNames}, sources)
}
