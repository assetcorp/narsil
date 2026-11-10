package persist

import (
	"context"
	"errors"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type segmentWriteRequest struct {
	schema            map[string]string
	tombstones        []string
	mergesIntoOneFile bool
}

type segmentWriteState struct {
	request           segmentWriteRequest
	workspace         *core.Workspace
	files             []*keyword.Segment
	tombstonesWritten bool
}

func (state *segmentWriteState) pendingTombstones() []string {
	if state.tombstonesWritten {
		return nil
	}
	return state.request.tombstones
}

func emptySegmentFile(schema map[string]string, tombstones []string) (*keyword.Segment, error) {
	empty := segments.Keyword{Segment: core.FrozenSegment{Terms: core.FrozenStrings{Offsets: []uint32{0}},
		PostingOffsets: []uint32{0}}}
	return empty.KeywordFile(segments.StoredDocuments{Schema: schema, Tombstones: tombstones, IDs: []string{},
		Documents: [][]byte{}})
}

func (state *segmentWriteState) fileOfGroup(group segmentFileGroup) (*keyword.Segment, error) {
	sources := make([]segments.Source, len(group.selections))
	for at, selection := range group.selections {
		resident, err := selection.Resident(state.workspace)
		if err != nil {
			return nil, err
		}
		sources[at] = resident.Source
		sources[at].Segment = at
	}
	merged, err := segments.Merge(state.workspace, sources)
	if err != nil {
		return nil, err
	}
	count := merged.Frozen.DocumentCount()
	stored := segments.StoredDocuments{Schema: state.request.schema, Tombstones: state.pendingTombstones(),
		IDs: make([]string, count), Documents: make([][]byte, count)}
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

func (state *segmentWriteState) writeGroup(group segmentFileGroup) error {
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

func writeSegmentsOf(selections []partition.Selection, request segmentWriteRequest) ([]*keyword.Segment, error) {
	w, err := core.AcquireWorkspace()
	if err != nil {
		return nil, err
	}
	defer w.Release()
	state := &segmentWriteState{request: request, workspace: w, files: []*keyword.Segment{}}
	groups := []segmentFileGroup{{selections: selections, documentCount: keptDocumentCount(selections)}}
	if !request.mergesIntoOneFile {
		if groups, err = groupsOfSelections(selections, request); err != nil {
			return nil, err
		}
	}
	for _, group := range groups {
		if group.documentCount == 0 {
			continue
		}
		if err := state.writeGroup(group); err != nil {
			return nil, err
		}
	}
	if !state.tombstonesWritten && len(request.tombstones) > 0 {
		empty, err := emptySegmentFile(request.schema, request.tombstones)
		if err != nil {
			return nil, err
		}
		state.files = append(state.files, empty)
	}
	return state.files, nil
}

func partitionSegmentFiles(ctx context.Context, target *index.Index, partitionID int,
	request segmentWriteRequest) ([]*keyword.Segment, error) {
	if _, err := target.FreezeLiveTail(partitionID, 1); err != nil {
		return nil, err
	}
	reading, err := target.Read(ctx)
	if err != nil {
		return nil, err
	}
	defer reading.Release()
	snapshot := reading.Snapshots[partitionID]
	if snapshot.GrowingCount() > 0 {
		return nil, narsilerr.New(narsilerr.CodePersistenceSaveFailed,
			"A write reached the partition while its checkpoint segments were being built",
			map[string]any{"partitionId": partitionID})
	}
	return writeSegmentsOf(snapshot.Selections(), request)
}
