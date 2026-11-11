package persist

import (
	"context"
	"math"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/archive"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/writeahead"
)

type HistoryLimits struct {
	MaxAgeMs uint64
	MaxBytes uint64
}

type sizedHistorySegment struct {
	historySegment
	bytes     uint64
	lastSeqNo uint64
}

func (durable *Durable) sizedHistory() (map[uint32][]sizedHistorySegment, uint64, error) {
	directory, name := durable.manager.directory, durable.handle.Name
	segments, err := listHistory(directory, name)
	if err != nil {
		return nil, 0, err
	}
	queues := map[uint32][]sizedHistorySegment{}
	var total uint64
	for _, segment := range segments {
		size, present, err := directory.Size(segment.key)
		if err != nil {
			return nil, 0, err
		}
		if !present || size < 0 {
			continue
		}
		queues[segment.partition] = append(queues[segment.partition],
			sizedHistorySegment{historySegment: segment, bytes: uint64(size), lastSeqNo: math.MaxUint64})
		total += uint64(size)
	}
	for partitionID, queue := range queues {
		logStart, found, err := writeahead.FirstSegmentStart(directory, name, partitionID)
		if err != nil {
			return nil, 0, err
		}
		for at := range queue {
			switch {
			case at+1 < len(queue):
				queue[at].lastSeqNo = queue[at+1].startSeqNo - 1
			case found:
				queue[at].lastSeqNo = logStart - 1
			}
		}
	}
	return queues, total, nil
}

func nextHistoryToDelete(queues map[uint32][]sizedHistorySegment, total uint64, limits HistoryLimits,
	nowMs uint64) (sizedHistorySegment, bool) {
	var oldest sizedHistorySegment
	found := false
	for _, queue := range queues {
		if len(queue) == 0 {
			continue
		}
		head := queue[0]
		if !found || head.movedAtMs < oldest.movedAtMs {
			oldest, found = head, true
		}
	}
	if !found {
		return sizedHistorySegment{}, false
	}
	expired := limits.MaxAgeMs < nowMs && oldest.movedAtMs < nowMs-limits.MaxAgeMs
	return oldest, expired || total > limits.MaxBytes
}

func publishedLastSeqNo(published *PublishedSnapshot, partitionID uint32) (uint64, bool) {
	if published == nil {
		return 0, false
	}
	for _, entry := range published.Manifest.Checkpoint {
		if entry.PartitionID == partitionID {
			return entry.LastSeqNo, true
		}
	}
	return 0, true
}

func (durable *Durable) EnforceSyncHistory(ctx context.Context, limits HistoryLimits, publish func(context.Context) error,
	nowMs uint64) (int, error) {
	if durable.manager.directory == nil {
		return 0, nil
	}
	published, err := durable.Published(ctx)
	if err != nil {
		return 0, err
	}
	queues, total, err := durable.sizedHistory()
	if err != nil {
		return 0, err
	}
	republished, deleted := false, 0
	for {
		if err := ctx.Err(); err != nil {
			return deleted, err
		}
		segment, due := nextHistoryToDelete(queues, total, limits, nowMs)
		if !due {
			return deleted, nil
		}
		last, known := publishedLastSeqNo(published, segment.partition)
		if !republished && publish != nil && (!known || segment.lastSeqNo > last) {
			republished = true
			if err := publish(ctx); err != nil {
				return deleted, err
			}
		}
		if err := durable.manager.directory.Remove(segment.key); err != nil {
			return deleted, err
		}
		queues[segment.partition] = queues[segment.partition][1:]
		total -= segment.bytes
		deleted++
	}
}

func (durable *Durable) PublishedArchiveBytes(ctx context.Context) (uint64, bool, error) {
	published, err := durable.Published(ctx)
	if err != nil || published == nil {
		return 0, false, err
	}
	prefix := durable.handle.Name + "/"
	length, err := archiveByteLength(published, prefix)
	return length, err == nil, err
}

func archiveByteLength(published *PublishedSnapshot, prefix string) (uint64, error) {
	var total uint64
	add := func(name string, size uint64) error {
		headers, err := archive.EntryHeaders(name, int64(size))
		if err != nil {
			return err
		}
		for _, header := range headers {
			total += uint64(len(header))
		}
		total += size + uint64(archive.Padding(int64(size)))
		return nil
	}
	if err := add(archive.ConfigEntry, uint64(len(published.Config))); err != nil {
		return 0, err
	}
	if err := add(archive.ManifestEntry, uint64(len(published.ManifestBytes))); err != nil {
		return 0, err
	}
	for _, file := range published.Manifest.Files() {
		if err := add(strings.TrimPrefix(file.Key, prefix), file.Bytes); err != nil {
			return 0, err
		}
	}
	return total + uint64(len(archive.EndBlocks())), nil
}
