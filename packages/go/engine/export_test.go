package engine

import "context"

type PartitionSegments struct {
	FrozenSegments   int
	GrowingDocuments int
}

func PartitionSegmentsOf(ctx context.Context, n *Narsil, indexName string) ([]PartitionSegments, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return nil, err
	}
	defer release()
	reading, err := entry.index().Read(ctx)
	if err != nil {
		return nil, err
	}
	defer reading.Release()
	held := make([]PartitionSegments, len(reading.Snapshots))
	for partitionID, snapshot := range reading.Snapshots {
		held[partitionID] = PartitionSegments{FrozenSegments: len(snapshot.SegmentSizes()),
			GrowingDocuments: snapshot.GrowingCount()}
	}
	return held, nil
}

func SearchedSegmentsOf(ctx context.Context, n *Narsil, indexName string) ([]int, error) {
	held, err := PartitionSegmentsOf(ctx, n, indexName)
	if err != nil {
		return nil, err
	}
	counts := make([]int, len(held))
	for partitionID, partition := range held {
		counts[partitionID] = partition.FrozenSegments
		if partition.GrowingDocuments > 0 {
			counts[partitionID]++
		}
	}
	return counts, nil
}
