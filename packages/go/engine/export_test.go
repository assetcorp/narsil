package engine

import "context"

func SearchedSegmentsOf(ctx context.Context, n *Narsil, indexName string) ([]int, error) {
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
	counts := make([]int, len(reading.Snapshots))
	for partitionID, snapshot := range reading.Snapshots {
		counts[partitionID] = len(snapshot.SegmentSizes())
		if snapshot.GrowingCount() > 0 {
			counts[partitionID]++
		}
	}
	return counts, nil
}
