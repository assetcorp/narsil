package index

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
)

func (ix *Index) TrackChanges() ([]*partition.ChangeLog, error) {
	logs := make([]*partition.ChangeLog, len(ix.partitions))
	err := ix.Write(func(w *Write) error {
		for at, held := range ix.partitions {
			logs[at] = held.TrackChanges(w.write)
		}
		return nil
	})
	return logs, err
}

func (ix *Index) StopTracking(logs []*partition.ChangeLog) error {
	return ix.Write(func(w *Write) error {
		for at, log := range logs {
			if at < len(ix.partitions) && log != nil {
				ix.partitions[at].StopTracking(w.write, log)
			}
		}
		return nil
	})
}

func (ix *Index) HeldPagedSegments(ctx context.Context, partitionID int) (map[string]*segments.Paged, error) {
	if err := ix.checkedPartition(partitionID); err != nil {
		return nil, err
	}
	reading, err := ix.Read(ctx)
	if err != nil {
		return nil, err
	}
	defer reading.Release()
	held := map[string]*segments.Paged{}
	for _, paged := range reading.Snapshots[partitionID].PagedSegments() {
		if paged.Hold() {
			held[paged.Path()] = paged
		}
	}
	return held, nil
}

func (ix *Index) PrepareAdoption(partitionID int, paged []*segments.Paged, kept []bool) (*partition.Adoption, error) {
	if err := ix.checkedPartition(partitionID); err != nil {
		return nil, err
	}
	return ix.partitions[partitionID].PrepareAdoption(paged, kept)
}

func (ix *Index) Adopt(partitionID int, adoption *partition.Adoption, log *partition.ChangeLog) (bool, error) {
	if err := ix.checkedPartition(partitionID); err != nil {
		return false, err
	}
	adopted := false
	err := ix.Write(func(w *Write) error {
		var failed error
		adopted, failed = ix.partitions[partitionID].Adopt(w.write, adoption, log)
		return failed
	})
	return adopted, err
}
