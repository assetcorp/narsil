package index

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

func (ix *Index) PartitionStats() []model.PartitionStatsResult {
	held := ix.acquireAll(ix.allPartitionIDs())
	defer held.release()
	stats := make([]model.PartitionStatsResult, len(held.partitions))
	for at, view := range held.partitions {
		stats[at] = model.PartitionStatsResult{PartitionID: at, DocumentCount: view.Count(), EstimatedMemoryBytes: int64(view.EstimateBytes())}
	}
	return stats
}

func (ix *Index) EstimateMemoryBytes() int64 {
	var total int64
	for _, partition := range ix.PartitionStats() {
		total += partition.EstimatedMemoryBytes
	}
	return total
}
