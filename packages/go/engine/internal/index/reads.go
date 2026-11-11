package index

import (
	"context"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/projection"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
)

type Reading struct {
	read      *partition.Read
	Snapshots []partition.Snapshot
}

func (r *Reading) Release() {
	r.read.Release()
}

type pinnedReadKey struct{}

func (ix *Index) pinnedRead(ctx context.Context) (*partition.Read, bool) {
	pinned, held := ctx.Value(pinnedReadKey{}).(*partition.Read)
	return pinned, held && pinned.Of(ix.sides)
}

func (ix *Index) read(ctx context.Context) (*partition.Read, error) {
	if pinned, held := ix.pinnedRead(ctx); held {
		if borrowed, reading := pinned.Borrow(); reading {
			return borrowed, nil
		}
	}
	return ix.sides.Read()
}

func (ix *Index) leaveKeywordSide(ctx context.Context) {
	if pinned, held := ix.pinnedRead(ctx); held {
		pinned.LeaveSide()
	}
}

func (ix *Index) Read(ctx context.Context) (*Reading, error) {
	read, err := ix.read(ctx)
	if err != nil {
		return nil, err
	}
	snapshots := make([]partition.Snapshot, len(ix.partitions))
	for at, held := range ix.partitions {
		snapshots[at] = held.Snapshot(read)
	}
	return &Reading{read: read, Snapshots: snapshots}, nil
}

func (ix *Index) Pin(ctx context.Context) (context.Context, func(), error) {
	if _, pinned := ix.pinnedRead(ctx); pinned {
		return ctx, func() {}, nil
	}
	read, err := ix.sides.Read()
	if err != nil {
		return nil, nil, err
	}
	return context.WithValue(vector.WithLease(ctx, read.Lease()), pinnedReadKey{}, read), read.Release, nil
}

func (ix *Index) RoutePartition(id string) int {
	return ix.partitionOf(id)
}

func (ix *Index) checkedPartition(partitionID int) error {
	if partitionID < 0 || partitionID >= len(ix.partitions) {
		return narsilerr.New(narsilerr.CodeConfigInvalid,
			"Partition "+strconv.Itoa(partitionID)+" does not exist in an index of "+strconv.Itoa(len(ix.partitions))+" partitions",
			map[string]any{"partitionId": partitionID, "partitionCount": len(ix.partitions)})
	}
	return nil
}

func (ix *Index) snapshotOf(ctx context.Context, partitionID int) (partition.Snapshot, func(), error) {
	read, err := ix.read(ctx)
	if err != nil {
		return partition.Snapshot{}, nil, err
	}
	return ix.partitions[partitionID].Snapshot(read), read.Release, nil
}

func (ix *Index) Get(ctx context.Context, id string) (*StoredDocument, bool, error) {
	snapshot, release, err := ix.snapshotOf(ctx, ix.partitionOf(id))
	if err != nil {
		return nil, false, err
	}
	defer release()
	document, found, err := snapshot.Document(id)
	if err != nil || !found {
		return nil, false, err
	}
	return &StoredDocument{ID: id, Document: document}, true, nil
}

func (ix *Index) GetProjected(ctx context.Context, id string, requested model.DocumentProjection) (*model.Document, bool, error) {
	stored, found, err := ix.Get(ctx, id)
	if err != nil || !found {
		return nil, false, err
	}
	shown := projection.Resolve(requested)
	if err := shown.Failure(stored.Document); err != nil {
		return nil, false, err
	}
	if shown.Kind() == model.ProjectWholeDocument {
		return stored.Document, true, nil
	}
	return shown.Clone(stored.Document), true, nil
}

func (ix *Index) Has(ctx context.Context, id string) (bool, error) {
	snapshot, release, err := ix.snapshotOf(ctx, ix.partitionOf(id))
	if err != nil {
		return false, err
	}
	defer release()
	return snapshot.Has(id)
}

func (ix *Index) Count() int {
	return ix.sides.DocumentCount()
}

func (ix *Index) PartitionDocumentCount(ctx context.Context, partitionID int) (int, error) {
	if err := ix.checkedPartition(partitionID); err != nil {
		return 0, err
	}
	snapshot, release, err := ix.snapshotOf(ctx, partitionID)
	if err != nil {
		return 0, err
	}
	defer release()
	return snapshot.Count(), nil
}
