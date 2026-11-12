package persist

import (
	"context"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

type removedRewrite struct {
	store     checkpoint.Store
	handle    *Handle
	prior     map[string]struct{}
	pagedText bool
	limit     uint64
	spent     uint64
}

func exceedsRemovedShare(removed int64, held int64) bool {
	return held > 0 && float64(removed) > float64(held)*RewriteAboveRemovedDocumentShare
}

func listedDocumentCount(listed []manifest.SegmentRef) int64 {
	var held int64
	for _, ref := range listed {
		held += int64(ref.DocCount)
	}
	return held
}

func idsOfScan(scan segmentScan) ([]string, error) {
	ids := make([]string, scan.count)
	for ordinal := range ids {
		id, err := scan.idAt(ordinal)
		if err != nil {
			return nil, err
		}
		ids[ordinal] = id
	}
	return ids, nil
}

func documentsReplacedLater(ctx context.Context, store checkpoint.Store, listed []manifest.SegmentRef,
	pagedText bool) ([][]string, error) {
	later := map[string]struct{}{}
	replaced := make([][]string, len(listed))
	for at := len(listed) - 1; at >= 0; at-- {
		scan, err := openSegmentScan(ctx, store, listed[at].File, pagedText)
		if err != nil {
			return nil, err
		}
		ids, err := idsOfScan(scan)
		tombstones := scan.tombstones
		scan.close()
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			if _, held := later[id]; held {
				replaced[at] = append(replaced[at], id)
			}
		}
		if at == 0 {
			break
		}
		for _, id := range ids {
			later[id] = struct{}{}
		}
		for id := range tombstones {
			later[id] = struct{}{}
		}
	}
	return replaced, nil
}

func freedBytesOf(ref manifest.SegmentRef, replacedCount int) float64 {
	if ref.DocCount == 0 {
		return 0
	}
	return float64(ref.File.Bytes) * float64(replacedCount) / float64(ref.DocCount)
}

func (rewrite *removedRewrite) choose(listed []manifest.SegmentRef, replaced [][]string) map[int]bool {
	held := listedDocumentCount(listed)
	var removed int64
	candidates := make([]int, 0, len(listed))
	for at := range listed {
		removed += int64(len(replaced[at]))
		if len(replaced[at]) > 0 {
			candidates = append(candidates, at)
		}
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		return freedBytesOf(listed[candidates[left]], len(replaced[candidates[left]])) >
			freedBytesOf(listed[candidates[right]], len(replaced[candidates[right]]))
	})
	chosen := map[int]bool{}
	for _, at := range candidates {
		if !exceedsRemovedShare(removed, held) {
			break
		}
		bytes := listed[at].File.Bytes
		if len(chosen) > 0 && rewrite.spent+bytes > rewrite.limit {
			continue
		}
		chosen[at] = true
		rewrite.spent += bytes
		held -= int64(len(replaced[at]))
		removed -= int64(len(replaced[at]))
	}
	return chosen
}

func (rewrite *removedRewrite) partition(ctx context.Context, entry *manifest.PartitionEntry, live int) (bool,
	error) {
	if live < 0 || rewrite.handle.NewDetachedIndex == nil {
		return false, nil
	}
	held := listedDocumentCount(entry.Segments)
	if !exceedsRemovedShare(held-int64(live), held) {
		return false, nil
	}
	replaced, err := documentsReplacedLater(ctx, rewrite.store, entry.Segments, rewrite.pagedText)
	if err != nil {
		return false, err
	}
	chosen := rewrite.choose(entry.Segments, replaced)
	if len(chosen) == 0 {
		return false, nil
	}
	listed := make([]manifest.SegmentRef, 0, len(entry.Segments))
	changed := false
	for at, ref := range entry.Segments {
		if !chosen[at] {
			listed = append(listed, ref)
			continue
		}
		written, rewritten, err := rewrite.segment(ctx, entry, ref, replaced[at], len(listed) == 0)
		if err != nil {
			return false, err
		}
		if !rewritten {
			listed = append(listed, ref)
			continue
		}
		changed = true
		listed = append(listed, written...)
	}
	entry.Segments = listed
	return changed, nil
}

func (rewrite *removedRewrite) removeUnlisted(ctx context.Context, ref manifest.SegmentRef) error {
	if _, priorListed := rewrite.prior[ref.File.Key]; priorListed {
		return nil
	}
	return rewrite.store.Remove(ctx, ref.File.Key)
}

func (rewrite *removedRewrite) segment(ctx context.Context, entry *manifest.PartitionEntry, ref manifest.SegmentRef,
	replaced []string, startsTheList bool) ([]manifest.SegmentRef, bool, error) {
	if _, located := rewrite.store.PathOf(ref.File.Key); rewrite.pagedText && !located {
		return nil, false, nil
	}
	handle := rewrite.handle
	detached, err := detachedIndexOf(handle)
	if err != nil {
		return nil, false, err
	}
	defer detached.Release()
	tombstoned := &windowTombstones{seen: map[string]struct{}{}}
	merge := windowMerge{store: rewrite.store, detached: detached, schema: flatSchema(handle),
		schemaOrder: schemaOrderOf(handle), pagedText: rewrite.pagedText, tombstoned: tombstoned}
	if rewrite.pagedText {
		if merge.pages, err = segments.NewMergePageCache(); err != nil {
			return nil, false, err
		}
	}
	if err := merge.attach(ctx, ref.File); err != nil {
		return nil, false, err
	}
	removed, err := heldDocumentIDs(ctx, detached, replaced)
	if err != nil {
		return nil, false, err
	}
	if err := applyInBatches(detached, index.WriteRemove, removalsOf(removed), firstSaveFailure); err != nil {
		return nil, false, err
	}
	var retained []string
	if !startsTheList {
		if retained, err = tombstoned.kept(ctx, detached, rewrite.pagedText,
			mergeWindow{start: 1, length: 1}); err != nil {
			return nil, false, err
		}
	}
	written := manifest.PartitionEntry{PartitionID: entry.PartitionID, NextSegmentID: entry.NextSegmentID,
		Segments: []manifest.SegmentRef{}}
	if detached.Count() > 0 || len(retained) > 0 {
		if err := writePartitionSegments(ctx, rewrite.store, handle.Name, detached, &written,
			segmentWriteRequest{schema: merge.schema, schemaOrder: merge.schemaOrder, tombstones: retained,
				mergesIntoOneFile: true}, rewrite.pagedText); err != nil {
			return nil, false, err
		}
	}
	if err := rewrite.removeUnlisted(ctx, ref); err != nil {
		return nil, false, err
	}
	entry.NextSegmentID = written.NextSegmentID
	return written.Segments, true, nil
}
