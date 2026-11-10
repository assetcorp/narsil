package persist

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/paged"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

func sourceHoldsPagedText(source coldSource, key string) (bool, error) {
	if source.size < envelope.HeaderBytes {
		return false, nil
	}
	start, err := readColdRange(source, 0, envelope.HeaderBytes, key)
	if err != nil {
		return false, err
	}
	header, err := envelope.ParseHeader(start)
	return err == nil && header.FormatVersion == paged.EnvelopeVersion, nil
}

func openedOlderSources(ctx context.Context, store checkpoint.Store, older []manifest.SegmentRef) ([]coldSource,
	bool, error) {
	sources := make([]coldSource, 0, len(older))
	allPaged := true
	for _, ref := range older {
		source, err := openColdSource(ctx, store, ref.File)
		if err != nil {
			closeSources(sources)
			return nil, false, err
		}
		sources = append(sources, source)
		holds, err := sourceHoldsPagedText(source, ref.File.Key)
		if err != nil {
			closeSources(sources)
			return nil, false, err
		}
		allPaged = allPaged && holds
	}
	return sources, allPaged, nil
}

func closeSources(sources []coldSource) {
	for _, source := range sources {
		source.close()
	}
}

func pagedTombstonesFor(ctx context.Context, store checkpoint.Store, older []manifest.SegmentRef,
	ids []string, deleted []string) ([]string, error) {
	tombstones := &windowTombstones{ordered: []string{}, seen: map[string]struct{}{}}
	for _, id := range deleted {
		tombstones.add(id)
	}
	if len(older) == 0 {
		return tombstones.ordered, nil
	}
	sources, allPaged, err := openedOlderSources(ctx, store, older)
	if err != nil {
		return nil, err
	}
	defer closeSources(sources)
	if !allPaged {
		for _, id := range ids {
			tombstones.add(id)
		}
		return tombstones.ordered, nil
	}
	cache := paged.NewReadCache(paged.MergeReadCacheBytes)
	for at, source := range sources {
		if err := addHeldIDs(tombstones, source, older[at].File.Key, cache, ids); err != nil {
			return nil, err
		}
	}
	return tombstones.ordered, nil
}

func addHeldIDs(tombstones *windowTombstones, source coldSource, key string, cache *paged.ReadCache,
	ids []string) error {
	reader, err := paged.OpenCached(source.reader, source.size, key, cache)
	if err != nil {
		return err
	}
	defer reader.Close()
	for _, id := range ids {
		if _, present := tombstones.seen[id]; present {
			continue
		}
		ordinal, err := reader.OrdinalOf(id)
		if err != nil {
			return err
		}
		if ordinal >= 0 {
			tombstones.add(id)
		}
	}
	return nil
}
