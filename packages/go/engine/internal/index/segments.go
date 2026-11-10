package index

import (
	"cmp"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
)

type CompactionPolicy uint8

const (
	CompactWhileIngesting CompactionPolicy = iota
	CompactWhileIdle
)

func (ix *Index) FreezeLiveTail(partitionID, minimumDocuments int) (bool, error) {
	if err := ix.checkedPartition(partitionID); err != nil {
		return false, err
	}
	froze := false
	err := ix.Write(func(w *Write) error {
		var err error
		froze, err = ix.partitions[partitionID].FreezeGrowing(w.write, minimumDocuments)
		return err
	})
	return froze, err
}

func smallestSegments(sizes []partition.SegmentSize, limit int) []int {
	ordered := slices.Clone(sizes)
	slices.SortStableFunc(ordered, func(left, right partition.SegmentSize) int {
		return cmp.Compare(left.LiveDocuments, right.LiveDocuments)
	})
	positions := make([]int, 0, min(limit, len(ordered)))
	for _, size := range ordered[:min(limit, len(ordered))] {
		positions = append(positions, size.Position)
	}
	return positions
}

func pickSegments(sizes []partition.SegmentSize, policy CompactionPolicy) []int {
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

func (ix *Index) compactSegments(policy CompactionPolicy, stopped func() bool) (int, error) {
	merges := 0
	pick := func(sizes []partition.SegmentSize) []int { return pickSegments(sizes, policy) }
	for _, held := range ix.partitions {
		if stopped() {
			return merges, nil
		}
		for range maxCompactionRounds {
			if stopped() {
				return merges, nil
			}
			merged, err := held.Merge(ix.sides, pick)
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
