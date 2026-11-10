package persist

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

func checkPagedSegmentFully(ctx context.Context, store checkpoint.Store, ref manifest.FileRef) error {
	source, err := openColdSource(ctx, store, ref)
	if err != nil {
		return err
	}
	defer source.close()
	reader, err := paged.OpenCached(source.reader, source.size, ref.Key, paged.NewReadCache(paged.MergeReadCacheBytes))
	if err != nil {
		return err
	}
	defer reader.Close()
	return reader.CheckFully()
}

func requireStagedPagedSegments(ctx context.Context, store checkpoint.Store, listed manifest.Manifest) error {
	for _, entry := range listed.Partitions {
		for _, ref := range entry.Segments {
			_, held, err := checkpoint.ListedPagedPath(ctx, store, ref.File)
			if err != nil {
				return err
			}
			if !held {
				continue
			}
			if err := checkPagedSegmentFully(ctx, store, ref.File); err != nil {
				return err
			}
		}
	}
	return nil
}
