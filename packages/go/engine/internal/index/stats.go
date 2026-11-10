package index

import (
	"context"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (ix *Index) PartitionStats() ([]model.PartitionStatsResult, error) {
	reading, err := ix.Read(context.Background())
	if err != nil {
		return nil, err
	}
	defer reading.Release()
	stats := make([]model.PartitionStatsResult, len(reading.Snapshots))
	for at, snapshot := range reading.Snapshots {
		stats[at] = model.PartitionStatsResult{
			PartitionID:          at,
			DocumentCount:        snapshot.Count(),
			EstimatedMemoryBytes: int64(min(snapshot.EstimatedBytes(), math.MaxInt64)),
		}
	}
	return stats, nil
}

func (ix *Index) EstimateMemoryBytes() (int64, error) {
	partitions, err := ix.PartitionStats()
	if err != nil {
		return 0, err
	}
	var total int64
	for _, partition := range partitions {
		total = int64(min(uint64(total)+uint64(partition.EstimatedMemoryBytes), math.MaxInt64))
	}
	return total, nil
}
