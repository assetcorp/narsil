package segment

import (
	"context"
	"io"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
)

type StreamedSegment struct {
	Schema      map[string]string
	SchemaOrder []string
	Tombstones  []string
	Inputs      []StreamedInput
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

func (stream *pagedStream) residentSources(w *core.Workspace, merge *streamedMerge, lists *streamedLists,
	documents *writtenDocuments) ([]paged.SectionSource, *keyword.SurfaceFormColumn, error) {
	terms := lists.terms()
	surfaces, partialWords, err := merge.mergeStrings(w, terms)
	if err != nil {
		return nil, nil, err
	}
	fields, err := merge.mergeFieldColumns(w)
	if err != nil {
		return nil, nil, err
	}
	resident, err := paged.ResidentSources(paged.ResidentColumns{Tokens: terms.Text,
		TokenOffsets: keyword.Uint32sOf(terms.Offsets...), DocumentFrequencies: keyword.Uint32sOf(terms.Counts...),
		PostingOffsets: lists.postingOffsets, BlockLists: lists.blockLists, BlockListOffsets: lists.blockListOffsets,
		BlockSummaries: lists.blockSummaries, FieldLengths: merge.fieldLengthColumns(), Numeric: fields.Numeric,
		Sizes: fields.Sizes, Boolean: fields.Boolean, Enum: fields.Enum, Geopoint: fields.Geopoint,
		Pattern: fields.Pattern, PartialWords: partialWords, IDSample: documents.idSample}, documents.blocks)
	return resident, surfaces, err
}

func (stream *pagedStream) sources(ctx context.Context, w *core.Workspace, merge *streamedMerge) (
	[]paged.SectionSource, error) {
	lists, err := stream.writeLists(ctx, w, merge)
	if err != nil {
		return nil, err
	}
	removalOffsets, removalValues, err := stream.writeRemovals()
	if err != nil {
		return nil, err
	}
	documents, err := stream.writeDocuments(ctx, merge)
	if err != nil {
		return nil, err
	}
	resident, surfaces, err := stream.residentSources(w, merge, lists, documents)
	if err != nil {
		return nil, err
	}
	streamed, err := sinkSources(lists.postings, lists.tokenTotals, lists.positionOffsets, lists.positions,
		documents.documents, documents.ids, documents.idOffsets, documents.idOrder, removalOffsets, removalValues,
		documents.seqNos, documents.primaryTerms)
	if err != nil {
		return nil, err
	}
	sources := append(resident, streamed...)
	if surfaces != nil {
		sources = append(sources, paged.SurfaceFormSource(surfaces))
	}
	return sources, nil
}

func WriteStreamed(ctx context.Context, writer io.Writer, scratchPath string, request StreamedSegment) (
	keyword.Written, uint32, error) {
	w, err := core.AcquireWorkspace()
	if err != nil {
		return keyword.Written{}, 0, err
	}
	defer w.Release()
	merge, err := prepareMerge(w, request.Inputs)
	if err != nil {
		return keyword.Written{}, 0, err
	}
	stream := &pagedStream{scratchPath: scratchPath}
	defer stream.discard()
	sources, err := stream.sources(ctx, w, merge)
	if err != nil {
		return keyword.Written{}, 0, err
	}
	schema := request.Schema
	if schema == nil {
		schema = map[string]string{}
	}
	written, err := paged.WriteSegment(writer, paged.HeadFields{Schema: schema, SchemaOrder: request.SchemaOrder,
		Tombstones: append([]string{}, request.Tombstones...), DocumentCount: merge.documentCount,
		FieldNames: merge.fieldNames}, sources)
	return written, merge.documentCount, err
}
