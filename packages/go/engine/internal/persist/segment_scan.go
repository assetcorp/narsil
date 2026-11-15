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
	return segmentScan{count: segment.DocumentTotal(), schema: segment.FieldSchema(),
		tombstones: idSetOf(segment.RemovedIDs()),
		idAt:       func(ordinal int) (string, error) { return segment.DocumentID(ordinal), nil },
		encodedAt:  segment.EncodedDocument, close: func() {}}
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
		encodedAt: func(ordinal int) ([]byte, error) { return reader.EncodedDocument(uint32(ordinal)) },
		close: func() {
			reader.Close()
			source.close()
		}}, nil
}

func openSegmentScan(ctx context.Context, store checkpoint.Store, ref manifest.FileRef, pagedText bool) (segmentScan,
	error) {
	return openSegmentScanInto(ctx, store, ref, pagedText, nil)
}

func openSegmentScanInto(ctx context.Context, store checkpoint.Store, ref manifest.FileRef, pagedText bool,
	buffer *[]byte) (segmentScan, error) {
	if pagedText {
		_, held, err := checkpoint.ListedPagedPath(ctx, store, ref)
		if err != nil {
			return segmentScan{}, err
		}
		if held {
			return pagedSegmentScan(ctx, store, ref)
		}
	}
	if buffer == nil {
		segment, err := checkpoint.OpenStoredSegment(ctx, store, ref, pagedText)
		if err != nil {
			return segmentScan{}, err
		}
		return wholeSegmentScan(segment), nil
	}
	data, err := checkpoint.ReadListedInto(ctx, store, ref, "segment", *buffer)
	if err != nil {
		return segmentScan{}, err
	}
	*buffer = data
	segment, err := checkpoint.StoredSegmentFrom(ref, data, pagedText)
	if err != nil {
		return segmentScan{}, err
	}
	return wholeSegmentScan(segment), nil
}
