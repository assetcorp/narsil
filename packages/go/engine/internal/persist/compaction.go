package persist

import (
	"context"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/segment"
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

func (held *windowTombstones) addReplaced(opened checkpoint.StoredSegment, pagedText bool) {
	for _, id := range opened.RemovedIDs() {
		held.add(id)
	}
	if !pagedText || opened.HoldsPagedText() {
		return
	}
	for ordinal := range opened.DocumentTotal() {
		held.add(opened.DocumentID(ordinal))
	}
}

func (held *windowTombstones) kept(detached *index.Index, pagedText bool, window mergeWindow) []string {
	if pagedText {
		if window.start == 0 {
			return nil
		}
		return held.ordered
	}
	retained := make([]string, 0, len(held.ordered))
	for _, id := range held.ordered {
		if !detached.Has(id) {
			retained = append(retained, id)
		}
	}
	return retained
}

func mergedTargetBytes(pagedText bool) int64 {
	if pagedText {
		return math.MaxInt64
	}
	return envelope.MaxFileBytes - SegmentFileFramingSlackBytes
}

func mergeWindowOf(ctx context.Context, store checkpoint.Store, handle *Handle, prior map[string]struct{},
	entry *manifest.PartitionEntry, window mergeWindow, pagedText bool) error {
	detached, err := detachedIndexOf(handle)
	if err != nil {
		return err
	}
	replaced := entry.Segments[window.start : window.start+window.length]
	tombstoned := &windowTombstones{seen: map[string]struct{}{}}
	for _, ref := range replaced {
		opened, err := checkpoint.OpenStoredSegment(ctx, store, ref.File, pagedText)
		if err != nil {
			return err
		}
		tombstoned.addReplaced(opened, pagedText)
		if err := loadSegment(detached, insertsEveryDocument, opened); err != nil {
			return err
		}
	}
	retained := tombstoned.kept(detached, pagedText, window)
	built, err := segmentsOfDetached(detached, segment.BuildOptions{Schema: flatSchema(handle),
		TargetBytes: mergedTargetBytes(pagedText), Tombstones: retained, KeepsEmpty: len(retained) > 0})
	if err != nil {
		return err
	}
	merged := manifest.PartitionEntry{PartitionID: entry.PartitionID, NextSegmentID: entry.NextSegmentID,
		Segments: []manifest.SegmentRef{}}
	if err := checkpoint.AppendSegments(ctx, store, handle.Name, &merged, built, pagedText); err != nil {
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

func compactWritten(ctx context.Context, store checkpoint.Store, handle *Handle, prior *manifest.Manifest,
	written *checkpoint.Written, threshold int, pagedText bool) error {
	priorKeys := map[string]struct{}{}
	if prior != nil {
		priorKeys = checkpoint.ReferencedKeys(*prior)
	}
	compacted := false
	for at := range written.Manifest.Partitions {
		entry := &written.Manifest.Partitions[at]
		merged, err := compactPartition(ctx, store, handle, priorKeys, entry, threshold, pagedText)
		if err != nil {
			return err
		}
		compacted = compacted || merged
	}
	if !compacted || prior == nil {
		return nil
	}
	listed := checkpoint.ReferencedKeys(written.Manifest)
	written.Garbage = written.Garbage[:0]
	for _, key := range prior.ListedKeys() {
		if _, kept := listed[key]; !kept {
			written.Garbage = append(written.Garbage, key)
		}
	}
	return nil
}
