package persist

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

type segmentScan struct {
	count      int
	schema     map[string]string
	tombstones map[string]struct{}
	idAt       func(ordinal int) (string, error)
	holds      func(id string) (bool, error)
	encodedAt  func(ordinal int) ([]byte, error)
	close      func()
}

func idSetOf(ids []string) map[string]struct{} {
	held := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		held[id] = struct{}{}
	}
	return held
}

func wholeSegmentScan(segment checkpoint.StoredSegment) segmentScan {
	ids := make([]string, segment.DocumentTotal())
	for ordinal := range ids {
		ids[ordinal] = segment.DocumentID(ordinal)
	}
	held := idSetOf(ids)
	return segmentScan{count: len(ids), schema: segment.FieldSchema(), tombstones: idSetOf(segment.RemovedIDs()),
		idAt: func(ordinal int) (string, error) { return ids[ordinal], nil },
		holds: func(id string) (bool, error) {
			_, present := held[id]
			return present, nil
		},
		encodedAt: segment.EncodedDocument, close: func() {}}
}

func pagedSegmentScan(ctx context.Context, store checkpoint.Store, ref manifest.FileRef) (segmentScan, error) {
	source, err := openColdSource(ctx, store, ref)
	if err != nil {
		return segmentScan{}, err
	}
	reader, err := paged.OpenCached(source.reader, source.size, ref.Key, paged.NewReadCache(paged.MergeReadCacheBytes))
	if err != nil {
		source.close()
		return segmentScan{}, err
	}
	return segmentScan{count: int(reader.Head.DocumentCount), schema: reader.Head.Schema,
		tombstones: idSetOf(reader.Head.Tombstones),
		idAt: func(ordinal int) (string, error) {
			id, err := reader.IDBytes(uint32(ordinal))
			return string(id), err
		},
		holds: func(id string) (bool, error) {
			ordinal, err := reader.OrdinalOf(id)
			return ordinal >= 0, err
		},
		encodedAt: func(ordinal int) ([]byte, error) { return reader.EncodedDocument(uint32(ordinal)) },
		close: func() {
			reader.Close()
			source.close()
		}}, nil
}

func openSegmentScan(ctx context.Context, store checkpoint.Store, ref manifest.FileRef, pagedText bool) (segmentScan,
	error) {
	if pagedText {
		_, held, err := checkpoint.ListedPagedPath(ctx, store, ref)
		if err != nil {
			return segmentScan{}, err
		}
		if held {
			return pagedSegmentScan(ctx, store, ref)
		}
	}
	segment, err := checkpoint.OpenStoredSegment(ctx, store, ref, pagedText)
	if err != nil {
		return segmentScan{}, err
	}
	return wholeSegmentScan(segment), nil
}

func closeScans(scans []segmentScan) {
	for _, scan := range scans {
		scan.close()
	}
}

func countsAsLatestHolder(scans []segmentScan, at int, id string) (bool, error) {
	for later := at + 1; later < len(scans); later++ {
		if _, removed := scans[later].tombstones[id]; removed {
			return false, nil
		}
		held, err := scans[later].holds(id)
		if err != nil || held {
			return false, err
		}
	}
	return true, nil
}
