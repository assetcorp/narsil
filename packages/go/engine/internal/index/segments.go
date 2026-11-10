package index

import (
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/frozen"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type CompactionPolicy uint8

const (
	CompactWhileIngesting CompactionPolicy = iota
	CompactWhileIdle
)

func (ix *Index) FreezeLiveTail(partitionID, minimumDocuments int) (bool, error) {
	if partitionID < 0 || partitionID >= len(ix.partitions) {
		return false, unknownPartition(partitionID)
	}
	return ix.partitions[partitionID].FreezeLiveTail(max(1, minimumDocuments)), nil
}

func (ix *Index) FreezeLiveTails(minimumDocuments int) int {
	frozenCount := 0
	for _, held := range ix.partitions {
		if held.FreezeLiveTail(max(1, minimumDocuments)) {
			frozenCount++
		}
	}
	return frozenCount
}

func (ix *Index) FrozenSegmentSizes(partitionID int) ([]partition.SegmentSize, error) {
	if partitionID < 0 || partitionID >= len(ix.partitions) {
		return nil, unknownPartition(partitionID)
	}
	var sizes []partition.SegmentSize
	ix.partitions[partitionID].Read(func(view partition.View) { sizes = view.FrozenSegmentSizes() })
	return sizes, nil
}

func smallestSegments(sizes []partition.SegmentSize, limit int) []*frozen.Segment {
	ordered := append([]partition.SegmentSize(nil), sizes...)
	sort.SliceStable(ordered, func(left, right int) bool { return ordered[left].LiveDocuments < ordered[right].LiveDocuments })
	if len(ordered) > limit {
		ordered = ordered[:limit]
	}
	picked := make([]*frozen.Segment, len(ordered))
	for at, size := range ordered {
		picked[at] = size.Segment
	}
	return picked
}

func pickSegments(sizes []partition.SegmentSize, policy CompactionPolicy) []*frozen.Segment {
	if policy == CompactWhileIdle {
		if len(sizes) >= 2 {
			return smallestSegments(sizes, segmentsPerMerge)
		}
		return nil
	}
	if len(sizes) >= compactionSegmentTrigger {
		return smallestSegments(sizes, compactionSegmentTrigger)
	}
	return nil
}

func (ix *Index) CompactSegments(policy CompactionPolicy) (int, error) {
	merges := 0
	pick := func(sizes []partition.SegmentSize) []*frozen.Segment { return pickSegments(sizes, policy) }
	for _, held := range ix.partitions {
		if policy == CompactWhileIdle {
			held.FreezeLiveTail(liveTailFreezeFloor)
		}
		for round := 0; round < maxCompactionRounds; round++ {
			merged, err := held.MergePicked(pick)
			if err != nil {
				return merges, err
			}
			if !merged {
				break
			}
			merges++
		}
	}
	return merges, nil
}

func (ix *Index) MergeSegments(partitionID int, segments []*frozen.Segment) (bool, error) {
	if partitionID < 0 || partitionID >= len(ix.partitions) {
		return false, unknownPartition(partitionID)
	}
	return ix.partitions[partitionID].MergeSegments(segments)
}

func (ix *Index) AttachFrozenSegment(partitionID int, segment *frozen.Segment, tombstonedIDs []string) error {
	if partitionID < 0 || partitionID >= len(ix.partitions) {
		return unknownPartition(partitionID)
	}
	return ix.partitions[partitionID].AttachFrozenSegment(segment, tombstonedIDs)
}

func (ix *Index) AttachStoredSegment(partitionID int, stored partition.StoredSegment) error {
	if partitionID < 0 || partitionID >= len(ix.partitions) {
		return unknownPartition(partitionID)
	}
	return ix.partitions[partitionID].AttachStoredSegment(stored)
}

func unknownPartition(partitionID int) error {
	return narsilerr.New(narsilerr.CodePartitionCorrupted, "The index holds no partition with this identifier",
		map[string]any{"partitionId": partitionID})
}
