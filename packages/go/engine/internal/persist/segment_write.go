package persist

import (
	"context"
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/segment"
)

type segmentWriteRequest struct {
	schema            map[string]string
	schemaOrder       []string
	tombstones        []string
	mergesIntoOneFile bool
}

type segmentWriteState struct {
	request           segmentWriteRequest
	workspace         *core.Workspace
	files             []*keyword.Segment
	stream            func(streamed segment.StreamedSegment) error
	tombstonesWritten bool
}

func (state *segmentWriteState) pendingTombstones() []string {
	if state.tombstonesWritten {
		return nil
	}
	return state.request.tombstones
}

func emptySegmentFile(request segmentWriteRequest) (*keyword.Segment, error) {
	empty := segments.Keyword{Segment: core.FrozenSegment{Terms: core.FrozenStrings{Offsets: []uint32{0}},
		PostingOffsets: []uint32{0}}}
	return empty.KeywordFile(segments.StoredDocuments{Schema: request.schema, SchemaOrder: request.schemaOrder,
		Tombstones: request.tombstones, IDs: []string{}, Documents: [][]byte{}})
}

func (state *segmentWriteState) fileOfGroup(group segmentFileGroup) (*keyword.Segment, error) {
	sources := make([]segments.Source, len(group.selections))
	for at, selection := range group.selections {
		if selection.Paged() {
			return nil, narsilerr.New(narsilerr.CodePersistenceSaveFailed,
				"A segment that keeps its text on disk can only be written into a durable checkpoint", nil)
		}
		sources[at] = selection.Source
		sources[at].Segment = at
	}
	merged, err := segments.Merge(state.workspace, sources)
	if err != nil {
		return nil, err
	}
	count := merged.Frozen.DocumentCount()
	stored := segments.StoredDocuments{Schema: state.request.schema, SchemaOrder: state.request.schemaOrder,
		Tombstones: state.pendingTombstones(), IDs: make([]string, count), Documents: make([][]byte, count)}
	for at, input := range merged.Segments {
		for ordinal, target := range merged.Mappings[at] {
			if target == core.MergeDroppedOrdinal {
				continue
			}
			id, encoded, err := group.selections[input].Document(uint32(ordinal))
			if err != nil {
				return nil, err
			}
			stored.IDs[target], stored.Documents[target] = id, encoded
		}
	}
	return merged.Frozen.KeywordFile(stored)
}

func encodedFileBytes(file *keyword.Segment) (int64, error) {
	chunks, err := file.PayloadChunks()
	if err != nil {
		return 0, err
	}
	total := int64(envelope.HeaderBytes)
	for _, chunk := range chunks {
		total += int64(len(chunk))
	}
	return total, nil
}

func (state *segmentWriteState) writeHalves(group segmentFileGroup) error {
	halves, err := halvesOf(group)
	if err != nil {
		return err
	}
	for _, half := range halves {
		if err := state.writeGroup(half); err != nil {
			return err
		}
	}
	return nil
}

func streamedOf(selections []partition.Selection, request segmentWriteRequest,
	tombstones []string) segment.StreamedSegment {
	streamed := segment.StreamedSegment{Schema: request.schema, SchemaOrder: request.schemaOrder, Tombstones: tombstones}
	for _, selection := range selections {
		streamed.Inputs = append(streamed.Inputs, segment.StreamedInput{Source: selection.Source,
			Paged: selection.PagedSegment(), Document: selection.Document})
	}
	return streamed
}

func (state *segmentWriteState) writePagedGroup(group segmentFileGroup) error {
	err := state.stream(streamedOf(group.selections, state.request, state.pendingTombstones()))
	if err == nil {
		state.tombstonesWritten = true
		return nil
	}
	if errors.Is(err, segments.ErrSegmentFull) && group.documentCount >= 2 {
		return state.writeHalves(group)
	}
	return narsilerr.Passthrough(err, narsilerr.CodePersistenceSaveFailed,
		"A checkpoint segment cannot be written from the frozen segments")
}

func (state *segmentWriteState) writeGroup(group segmentFileGroup) error {
	if state.stream != nil {
		return state.writePagedGroup(group)
	}
	file, err := state.fileOfGroup(group)
	if err != nil {
		if errors.Is(err, segments.ErrSegmentFull) && group.documentCount >= 2 {
			return state.writeHalves(group)
		}
		return narsilerr.Passthrough(err, narsilerr.CodePersistenceSaveFailed,
			"A checkpoint segment cannot be built from the frozen segments")
	}
	bytes, err := encodedFileBytes(file)
	if err != nil {
		return err
	}
	if bytes > envelope.MaxFileBytes && group.documentCount > 1 {
		return state.writeHalves(group)
	}
	state.files = append(state.files, file)
	state.tombstonesWritten = true
	return nil
}

func groupsOfSelections(selections []partition.Selection, request segmentWriteRequest) ([]segmentFileGroup,
	error) {
	if request.mergesIntoOneFile {
		return []segmentFileGroup{{selections: selections, documentCount: keptDocumentCount(selections)}}, nil
	}
	var groups []segmentFileGroup
	var inMemory []partition.Selection
	for _, selection := range selections {
		if !selection.Paged() {
			inMemory = append(inMemory, selection)
			continue
		}
		held := []partition.Selection{selection}
		groups = append(groups, segmentFileGroup{selections: held, documentCount: keptDocumentCount(held)})
	}
	split, err := splitIntoSegmentFiles(inMemory, request.schema, request.tombstones)
	return append(groups, split...), err
}

func requirePagedPayloads(selections []partition.Selection) error {
	for _, selection := range selections {
		if paged := selection.PagedSegment(); paged != nil {
			if err := paged.RequirePayloadChecksum(); err != nil {
				return err
			}
		}
	}
	return nil
}

func (state *segmentWriteState) writeSelections(selections []partition.Selection) error {
	groups, err := groupsOfSelections(selections, state.request)
	if err != nil {
		return err
	}
	for _, group := range groups {
		if group.documentCount > 0 {
			err = state.writeGroup(group)
		} else if state.stream != nil {
			err = requirePagedPayloads(group.selections)
		}
		if err != nil {
			return err
		}
	}
	if state.tombstonesWritten || len(state.request.tombstones) == 0 {
		return nil
	}
	if state.stream != nil {
		return state.stream(streamedOf(nil, state.request, state.request.tombstones))
	}
	empty, err := emptySegmentFile(state.request)
	if err != nil {
		return err
	}
	state.files = append(state.files, empty)
	return nil
}

func writeSegmentsOf(selections []partition.Selection, request segmentWriteRequest) ([]*keyword.Segment, error) {
	w, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer w.Release()
	state := &segmentWriteState{request: request, workspace: w, files: []*keyword.Segment{}}
	return state.files, state.writeSelections(selections)
}

func freezePartition(ctx context.Context, target *index.Index, partitionID int) (*index.Reading, error) {
	if _, err := target.FreezeLiveTail(partitionID, 1); err != nil {
		return nil, err
	}
	reading, err := target.Read(ctx)
	if err != nil {
		return nil, err
	}
	if reading.Snapshots[partitionID].GrowingCount() > 0 {
		reading.Release()
		return nil, narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			"A write reached the partition while its checkpoint segments were being built",
			map[string]any{"partitionId": partitionID})
	}
	return reading, nil
}

func partitionSegmentFiles(ctx context.Context, target *index.Index, partitionID int,
	request segmentWriteRequest) ([]*keyword.Segment, error) {
	reading, err := freezePartition(ctx, target, partitionID)
	if err != nil {
		return nil, err
	}
	defer reading.Release()
	files, err := writeSegmentsOf(reading.Snapshots[partitionID].Selections(), request)
	if err != nil {
		return nil, err
	}
	return files, nil
}

type heldSelections struct {
	selections []partition.Selection
	paged      []*segments.Paged
}

func (held *heldSelections) release() {
	for _, paged := range held.paged {
		paged.Close()
	}
	held.paged = nil
}

func holdPartitionSelections(ctx context.Context, target *index.Index, partitionID int) (*heldSelections, error) {
	reading, err := freezePartition(ctx, target, partitionID)
	if err != nil {
		return nil, err
	}
	defer reading.Release()
	held := &heldSelections{selections: reading.Snapshots[partitionID].Selections()}
	for _, selection := range held.selections {
		paged := selection.PagedSegment()
		if paged == nil {
			continue
		}
		if !paged.Hold() {
			held.release()
			return nil, narsilerr.New(narsilerr.CodePersistenceSaveFailed,
				"A paged segment of the partition closed while its checkpoint segments were being built",
				map[string]any{"partitionId": partitionID})
		}
		held.paged = append(held.paged, paged)
	}
	return held, nil
}

func (held *heldSelections) stream(ctx context.Context, store checkpoint.Store, indexName string,
	entry *manifest.PartitionEntry, request segmentWriteRequest) error {
	w, err := core.AcquireWorkspace()
	if err != nil {
		return err
	}
	defer w.Release()
	state := &segmentWriteState{request: request, workspace: w,
		stream: func(streamed segment.StreamedSegment) error {
			return checkpoint.AppendStreamed(ctx, store, indexName, entry, streamed)
		}}
	return state.writeSelections(held.selections)
}

func writePartitionSegments(ctx context.Context, store checkpoint.Store, indexName string, target *index.Index,
	entry *manifest.PartitionEntry, request segmentWriteRequest, pagedText bool) error {
	if !pagedText {
		built, err := partitionSegmentFiles(ctx, target, 0, request)
		if err != nil {
			return err
		}
		return checkpoint.AppendSegments(ctx, store, indexName, entry, built)
	}
	held, err := holdPartitionSelections(ctx, target, 0)
	if err != nil {
		return err
	}
	defer held.release()
	return held.stream(ctx, store, indexName, entry, request)
}
