package persist

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/segments"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

type mergeWindow struct {
	start  int
	length int
}

func windowFits(segments []manifest.SegmentRef, start int, length int, pagedText bool) bool {
	documents := uint64(0)
	bytes := uint64(SegmentFileFramingSlackBytes)
	for at := start; at < start+length; at++ {
		documents += uint64(segments[at].DocCount)
		bytes += segments[at].File.Bytes
	}
	if pagedText {
		return float64(bytes)*MergedSegmentGrowthAllowance <= MergedSegmentTargetBytes
	}
	return documents <= CompactionLargestMergedDocumentCount && bytes <= envelope.MaxFileBytes
}

func smallestFittingWindow(segments []manifest.SegmentRef, length int, pagedText bool) (mergeWindow, bool) {
	best, found := mergeWindow{}, false
	var bestBytes uint64
	for start := 0; start+length <= len(segments); start++ {
		if !windowFits(segments, start, length, pagedText) {
			continue
		}
		var bytes uint64
		for at := start; at < start+length; at++ {
			bytes += segments[at].File.Bytes
		}
		if !found || bytes < bestBytes {
			best, bestBytes, found = mergeWindow{start: start, length: length}, bytes, true
		}
	}
	return best, found
}

func chooseWindow(segments []manifest.SegmentRef, wanted int, pagedText bool) (mergeWindow, bool) {
	for length := min(wanted, len(segments)); length >= 2; length-- {
		if window, found := smallestFittingWindow(segments, length, pagedText); found {
			return window, true
		}
	}
	return mergeWindow{}, false
}

func compactPartition(ctx context.Context, store checkpoint.Store, handle *Handle, prior map[string]struct{},
	entry *manifest.PartitionEntry, threshold int, pagedText bool) (bool, error) {
	if len(entry.Segments) <= threshold || handle.NewDetachedIndex == nil {
		return false, nil
	}
	window, found := chooseWindow(entry.Segments, len(entry.Segments)-threshold+1, pagedText)
	if !found {
		return false, nil
	}
	if _, located := store.PathOf(entry.Segments[window.start].File.Key); pagedText && !located {
		return false, nil
	}
	return true, mergeWindowOf(ctx, store, handle, prior, entry, window, pagedText)
}

type windowTombstones struct {
	ordered []string
	seen    map[string]struct{}
}

func (held *windowTombstones) add(id string) {
	if _, present := held.seen[id]; !present {
		held.seen[id] = struct{}{}
		held.ordered = append(held.ordered, id)
	}
}

func (held *windowTombstones) addEvery(ids []string) {
	for _, id := range ids {
		held.add(id)
	}
}

func (held *windowTombstones) addReplaced(opened checkpoint.StoredSegment, pagedText bool) {
	held.addEvery(opened.RemovedIDs())
	if !pagedText {
		return
	}
	for ordinal := range opened.DocumentTotal() {
		held.add(opened.DocumentID(ordinal))
	}
}

type windowMerge struct {
	store       checkpoint.Store
	detached    *index.Index
	pages       *core.PageCache
	schema      map[string]string
	schemaOrder []string
	pagedText   bool
	tombstoned  *windowTombstones
}

func (merge windowMerge) attach(ctx context.Context, ref manifest.FileRef) error {
	if merge.pagedText {
		path, held, err := checkpoint.ListedPagedPath(ctx, merge.store, ref)
		if err != nil {
			return err
		}
		if held {
			return attachPagedFile(ctx, pagedAttachment{target: merge.detached, pages: merge.pages, key: ref.Key,
				path: path, schema: merge.schema, replaced: merge.tombstoned.addEvery})
		}
	}
	opened, err := checkpoint.OpenStoredSegment(ctx, merge.store, ref, false)
	if err != nil {
		return err
	}
	merge.tombstoned.addReplaced(opened, merge.pagedText)
	return loadSegment(ctx, merge.detached, 0, opened)
}

func (held *windowTombstones) kept(ctx context.Context, detached *index.Index, pagedText bool,
	window mergeWindow) ([]string, error) {
	if pagedText {
		if window.start == 0 {
			return nil, nil
		}
		return held.ordered, nil
	}
	retained := make([]string, 0, len(held.ordered))
	for _, id := range held.ordered {
		present, err := detached.Has(ctx, id)
		if err != nil {
			return nil, err
		}
		if !present {
			retained = append(retained, id)
		}
	}
	return retained, nil
}

func mergeWindowOf(ctx context.Context, store checkpoint.Store, handle *Handle, prior map[string]struct{},
	entry *manifest.PartitionEntry, window mergeWindow, pagedText bool) error {
	detached, err := detachedIndexOf(handle)
	if err != nil {
		return err
	}
	defer detached.Release()
	replaced := entry.Segments[window.start : window.start+window.length]
	tombstoned := &windowTombstones{seen: map[string]struct{}{}}
	merge := windowMerge{store: store, detached: detached, schema: flatSchema(handle), schemaOrder: schemaOrderOf(handle),
		pagedText: pagedText, tombstoned: tombstoned}
	if pagedText {
		if merge.pages, err = segments.NewMergePageCache(); err != nil {
			return err
		}
	}
	for _, ref := range replaced {
		if err := merge.attach(ctx, ref.File); err != nil {
			return err
		}
	}
	retained, err := tombstoned.kept(ctx, detached, pagedText, window)
	if err != nil {
		return err
	}
	merged := manifest.PartitionEntry{PartitionID: entry.PartitionID, NextSegmentID: entry.NextSegmentID,
		Segments: []manifest.SegmentRef{}}
	if err := writePartitionSegments(ctx, store, handle.Name, detached, &merged,
		segmentWriteRequest{schema: merge.schema, schemaOrder: merge.schemaOrder, tombstones: retained,
			mergesIntoOneFile: true}, pagedText); err != nil {
		return err
	}
	listed := make([]manifest.SegmentRef, 0, len(entry.Segments)-window.length+len(merged.Segments))
	listed = append(listed, entry.Segments[:window.start]...)
	listed = append(listed, merged.Segments...)
	listed = append(listed, entry.Segments[window.start+window.length:]...)
	for _, ref := range replaced {
		if _, priorListed := prior[ref.File.Key]; priorListed {
			continue
		}
		if err := store.Remove(ctx, ref.File.Key); err != nil {
			return err
		}
	}
	entry.Segments = listed
	entry.NextSegmentID = merged.NextSegmentID
	return nil
}

func liveDocumentsOf(live []int, partitionID uint32) int {
	if int(partitionID) >= len(live) {
		return -1
	}
	return live[partitionID]
}

func compactWritten(ctx context.Context, store checkpoint.Store, handle *Handle, prior *manifest.Manifest,
	written *checkpoint.Written, threshold int, pagedText bool, live []int) (map[uint32]bool, error) {
	priorKeys := map[string]struct{}{}
	if prior != nil {
		priorKeys = checkpoint.ReferencedKeys(*prior)
	}
	rewrite := &removedRewrite{store: store, handle: handle, prior: priorKeys, pagedText: pagedText}
	rewrittenPartitions := map[uint32]bool{}
	compacted := false
	for at := range written.Manifest.Partitions {
		entry := &written.Manifest.Partitions[at]
		merged, err := compactPartition(ctx, store, handle, priorKeys, entry, threshold, pagedText)
		if err != nil {
			return nil, err
		}
		rewritten, err := rewrite.partition(ctx, entry, liveDocumentsOf(live, entry.PartitionID))
		if err != nil {
			return nil, err
		}
		if rewritten {
			rewrittenPartitions[entry.PartitionID] = true
		}
		compacted = compacted || merged || rewritten
	}
	if !compacted || prior == nil {
		return rewrittenPartitions, nil
	}
	listed := checkpoint.ReferencedKeys(written.Manifest)
	written.Garbage = written.Garbage[:0]
	for _, key := range prior.ListedKeys() {
		if _, kept := listed[key]; !kept {
			written.Garbage = append(written.Garbage, key)
		}
	}
	return rewrittenPartitions, nil
}
