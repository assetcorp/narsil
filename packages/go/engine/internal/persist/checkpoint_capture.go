package persist

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

type capture struct {
	seqNos     []uint64
	whole      []bool
	logged     []bool
	left       uint64
	vectors    []checkpoint.VectorCapture
	partitions []checkpoint.PartitionCapture
	selections []*heldSelections
	frozen     *frozenReading
	changes    []*partition.ChangeLog
	tracked    *index.Index
}

type frozenReading struct {
	reading    *index.Reading
	partitions []int
}

func (frozen *frozenReading) release() {
	if frozen != nil && frozen.reading != nil {
		frozen.reading.Release()
		frozen.reading = nil
	}
}

func (held capture) release() {
	held.stopTracking()
	for _, field := range held.vectors {
		field.Plan.Release()
	}
	for _, selections := range held.selections {
		selections.release()
	}
	held.frozen.release()
}

func segmentWriteRequestOf(handle *Handle) segmentWriteRequest {
	return segmentWriteRequest{schema: flatSchema(handle), schemaOrder: schemaOrderOf(handle)}
}

func (held capture) writeFrozenPartitions(handle *Handle) error {
	frozen := held.frozen
	if frozen == nil || frozen.reading == nil {
		return nil
	}
	defer frozen.release()
	request := segmentWriteRequestOf(handle)
	for _, partitionID := range frozen.partitions {
		files, err := writeSegmentsOf(frozen.reading.Snapshots[partitionID].Selections(), request)
		if err != nil {
			return err
		}
		held.partitions[partitionID].Segments = files
	}
	return nil
}

func (held *capture) freezeWholePartitions(ctx context.Context, handle *Handle, store checkpoint.Store,
	pagedText bool) error {
	held.partitions = make([]checkpoint.PartitionCapture, len(held.seqNos))
	var whole []int
	for partitionID, seqNo := range held.seqNos {
		partition := &held.partitions[partitionID]
		partition.Checkpoint = manifest.PartitionCheckpoint{PartitionID: uint32(partitionID), LastSeqNo: seqNo,
			PrimaryTerm: SingleNodePrimaryTerm}
		if held.whole[partitionID] {
			partition.Rewritten = true
			whole = append(whole, partitionID)
		}
	}
	if len(whole) == 0 {
		return nil
	}
	reading, err := freezePartitions(ctx, handle.Index, whole)
	if err != nil {
		return err
	}
	held.frozen = &frozenReading{reading: reading, partitions: whole}
	if !pagedText {
		return nil
	}
	defer held.frozen.release()
	request := segmentWriteRequestOf(handle)
	for _, partitionID := range whole {
		selections, err := holdSelectionsOf(reading, partitionID)
		if err != nil {
			return err
		}
		held.selections = append(held.selections, selections)
		held.partitions[partitionID].Stream = func(ctx context.Context, entry *manifest.PartitionEntry) error {
			return selections.stream(ctx, store, handle.Name, entry, request)
		}
	}
	return nil
}
