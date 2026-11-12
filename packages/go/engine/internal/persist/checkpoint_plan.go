package persist

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

func logMatchesMemory(prior *manifest.Manifest, partitionCount int) bool {
	if partitionCount != 1 {
		return false
	}
	if prior != nil {
		for _, entry := range prior.Partitions {
			if entry.PartitionID != 0 {
				return false
			}
		}
	}
	return true
}

func (durable *Durable) mostOfEachChanged(prior *manifest.Manifest, held *capture, changed []int) bool {
	for _, partitionID := range changed {
		records := held.seqNos[partitionID] - priorSeqNoOf(prior, partitionID)
		documents, err := durable.handle.Index.PartitionDocumentCount(context.Background(), partitionID)
		if err != nil || documents > WholePartitionLargestDocumentCount ||
			float64(records) < float64(documents)*WholePartitionMinChangedShare {
			return false
		}
	}
	return true
}

func (durable *Durable) planPartitions(prior *manifest.Manifest, logged bool, options checkpointOptions,
	held *capture) {
	count := len(held.seqNos)
	held.whole, held.logged, held.left = make([]bool, count), make([]bool, count), 0
	capped := logged && !options.everyPartition && durable.handle.NewDetachedIndex != nil
	var changed []int
	for partitionID, applied := range held.seqNos {
		if capped {
			limit := priorSeqNoOf(prior, partitionID) + LogRecordsPerCheckpoint
			if applied > limit {
				held.left += applied - limit
				held.seqNos[partitionID] = limit
			}
		}
		if options.everyPartition || !partitionUnchanged(prior, partitionID, held.seqNos[partitionID]) {
			changed = append(changed, partitionID)
		}
	}
	fromMemory := !capped
	if !fromMemory && held.left == 0 && logMatchesMemory(prior, count) && durable.mostOfEachChanged(prior, held,
		changed) {
		fromMemory = true
	}
	for _, partitionID := range changed {
		if fromMemory {
			held.whole[partitionID] = true
		} else {
			held.logged[partitionID] = true
		}
	}
}

func (durable *Durable) liveDocumentCounts(ctx context.Context, held *capture) []int {
	if held.left > 0 {
		return nil
	}
	live := make([]int, len(held.seqNos))
	for partitionID := range live {
		count, err := durable.handle.Index.PartitionDocumentCount(ctx, partitionID)
		if err != nil {
			return nil
		}
		live[partitionID] = count
	}
	return live
}

func (durable *Durable) buildLoggedPartitions(ctx context.Context, store checkpoint.Store, prior *manifest.Manifest,
	held *capture) error {
	for partitionID, fromLog := range held.logged {
		if !fromLog {
			continue
		}
		entry, err := durable.writeLoggedPartition(ctx, store, prior, partitionID, held.seqNos[partitionID])
		if err != nil {
			return err
		}
		held.partitions[partitionID].Listed = &entry
	}
	return nil
}
