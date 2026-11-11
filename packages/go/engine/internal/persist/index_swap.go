package persist

import (
	"context"
	"errors"
	"sort"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/manifest"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/writeahead"
)

type IndexSwap struct {
	Index            *index.Index
	NewDetachedIndex func() (*index.Index, error)
	Buffered         *BufferedLog
	MetadataFirst    bool
	Committed        func(listed manifest.Manifest) bool
	Revert           func(previous *index.Index) error
}

type swappedLayout struct {
	index      *index.Index
	detached   func() (*index.Index, error)
	partitions []*partitionLog
}

func (durable *Durable) textStoredOnDisk() bool {
	durable.metadataMutex.Lock()
	defer durable.metadataMutex.Unlock()
	return textStoredOnDisk(durable.handle)
}

func (durable *Durable) lockLayout() {
	durable.layoutMutex.Lock()
	durable.metadataMutex.Lock()
	for _, log := range durable.partitions {
		log.mutex.Lock()
	}
}

func (durable *Durable) unlockLayout(partitions []*partitionLog) {
	for _, log := range partitions {
		log.mutex.Unlock()
	}
	durable.metadataMutex.Unlock()
	durable.layoutMutex.Unlock()
}

func (durable *Durable) installLayout(swap IndexSwap) swappedLayout {
	previous := swappedLayout{index: durable.handle.Index, detached: durable.handle.NewDetachedIndex,
		partitions: durable.partitions}
	for partitionID, log := range durable.partitions {
		if swap.Buffered != nil && partitionID < len(swap.Buffered.next) {
			log.applied = max(log.applied, swap.Buffered.next[partitionID])
		}
	}
	durable.handle.Index = swap.Index
	durable.handle.NewDetachedIndex = swap.NewDetachedIndex
	count := swap.Index.PartitionCount()
	if count == len(previous.partitions) {
		return previous
	}
	resized := make([]*partitionLog, count)
	for partitionID := range resized {
		if partitionID < len(previous.partitions) {
			resized[partitionID] = previous.partitions[partitionID]
			continue
		}
		resized[partitionID] = durable.newPartitionLog(partitionID)
		resized[partitionID].mutex.Lock()
	}
	durable.partitions = resized
	return previous
}

func (durable *Durable) checkpointEveryPartition(ctx context.Context) error {
	durable.stall.begin()
	defer durable.stall.end()
	options := checkpointOptions{everyPartition: true}
	for {
		_, left, err := durable.boundedCheckpoint(ctx, options)
		if err != nil || left == 0 || durable.closed.Load() || ctx.Err() != nil {
			return err
		}
		options.prior = nil
	}
}

func (durable *Durable) retire(logs []*partitionLog) {
	for _, log := range logs {
		if log.writer != nil {
			log.writer.Abandon()
		}
	}
}

func layoutUnion(previous []*partitionLog, current []*partitionLog) []*partitionLog {
	union := append([]*partitionLog(nil), previous...)
	if len(current) > len(previous) {
		union = append(union, current[len(previous):]...)
	}
	return union
}

func (durable *Durable) revertLayout(swap IndexSwap, previous swappedLayout) error {
	current := durable.partitions
	durable.lockLayout()
	for _, log := range previous.partitions[min(len(current), len(previous.partitions)):] {
		log.mutex.Lock()
	}
	durable.handle.Index = previous.index
	durable.handle.NewDetachedIndex = previous.detached
	durable.partitions = previous.partitions
	durable.unlockLayout(layoutUnion(previous.partitions, current))
	for partitionID := len(previous.partitions); partitionID < len(current); partitionID++ {
		if writer := current[partitionID].writer; writer != nil {
			writer.Abandon()
			_ = writeahead.RemovePartitionLog(durable.manager.directory, durable.handle.Name, uint32(partitionID))
		}
	}
	if swap.Revert != nil {
		return swap.Revert(previous.index)
	}
	return nil
}

func (durable *Durable) SwapIndex(ctx context.Context, prepare func() (IndexSwap, bool, error)) (bool, error) {
	durable.checkpointMutex.Lock()
	defer durable.checkpointMutex.Unlock()
	if err := durable.refuseWrites(); err != nil {
		return false, err
	}
	durable.lockLayout()
	held := durable.partitions
	swap, proceed, err := prepare()
	if err != nil || !proceed {
		durable.unlockLayout(held)
		return false, err
	}
	previous := durable.installLayout(swap)
	durable.unlockLayout(layoutUnion(held, durable.partitions))
	var retired []*partitionLog
	if len(previous.partitions) > len(durable.partitions) {
		retired = previous.partitions[len(durable.partitions):]
	}
	err = nil
	if swap.MetadataFirst {
		err = durable.writeMetadata(ctx, uint64(swap.Index.Count()))
	}
	if err == nil {
		err = durable.checkpointEveryPartition(ctx)
	}
	if err == nil {
		durable.retire(retired)
		return true, nil
	}
	read, readErr := checkpoint.ReadManifest(context.WithoutCancel(ctx), durable.manager.store, durable.handle.Name)
	if readErr == nil && read.Kind == checkpoint.ManifestCurrent && swap.Committed != nil && swap.Committed(read.Manifest) {
		durable.retire(retired)
		if metaErr := durable.writeMetadata(context.WithoutCancel(ctx), uint64(swap.Index.Count())); metaErr != nil {
			return true, metaErr
		}
		return true, nil
	}
	reverted := durable.revertLayout(swap, previous)
	_ = durable.writeMetadata(context.WithoutCancel(ctx), uint64(previous.index.Count()))
	return false, errors.Join(err, reverted)
}

func (handle *Handle) ApplyTo(ctx context.Context, target *index.Index, writes []Write, withVectors bool) ([]error,
	error) {
	routed := Handle{Name: handle.Name, Index: target, Schema: handle.Schema}
	if withVectors {
		routed.Vectors = handle.Vectors
	}
	return routed.apply(ctx, writes)
}

type BufferedLog struct {
	durable *Durable
	next    []uint64
	held    map[int]heldDocuments
}

func (durable *Durable) BeginBufferedLog() *BufferedLog {
	durable.layoutMutex.RLock()
	defer durable.layoutMutex.RUnlock()
	next := make([]uint64, len(durable.partitions))
	for partitionID, log := range durable.partitions {
		log.mutex.Lock()
		next[partitionID] = log.applied
		log.mutex.Unlock()
	}
	return &BufferedLog{durable: durable, next: next, held: map[int]heldDocuments{}}
}

func (buffered *BufferedLog) Append(ctx context.Context, writes []Write) error {
	durable := buffered.durable
	if err := durable.refuseWrites(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	groups := map[int][]Write{}
	for _, write := range writes {
		partitionID := durable.handle.Index.RoutePartition(write.DocumentID)
		groups[partitionID] = append(groups[partitionID], write)
	}
	order := make([]int, 0, len(groups))
	for partitionID := range groups {
		order = append(order, partitionID)
	}
	sort.Ints(order)
	durable.layoutMutex.RLock()
	defer durable.layoutMutex.RUnlock()
	var touched []*partitionLog
	var documentBytes int64
	for _, partitionID := range order {
		if partitionID >= len(durable.partitions) || partitionID >= len(buffered.next) {
			continue
		}
		log := durable.partitions[partitionID]
		logged, err := buffered.appendGroup(ctx, log, partitionID, groups[partitionID])
		if err != nil {
			return err
		}
		documentBytes += logged
		touched = append(touched, log)
	}
	if err := durable.commit(touched); err != nil {
		return err
	}
	durable.noteRecorded(len(writes), documentBytes)
	return nil
}

func (buffered *BufferedLog) heldFor(ctx context.Context, log *partitionLog, partitionID int,
	group []Write) (heldDocuments, error) {
	if log.writer == nil || !buffered.durable.handle.recordsPreviousDocuments() {
		return nil, nil
	}
	held, found := buffered.held[partitionID]
	if !found {
		held = heldDocuments{}
		buffered.held[partitionID] = held
	}
	return held, buffered.durable.handle.holdDocumentsBefore(ctx, held, group)
}

func (buffered *BufferedLog) appendGroup(ctx context.Context, log *partitionLog, partitionID int,
	group []Write) (int64, error) {
	durable := buffered.durable
	log.mutex.Lock()
	defer log.mutex.Unlock()
	if log.failed != nil {
		return 0, log.failed
	}
	held, err := buffered.heldFor(ctx, log, partitionID, group)
	if err != nil {
		return 0, err
	}
	entries := make([]wal.Entry, 0, len(group))
	var documentBytes int64
	for _, write := range group {
		buffered.next[partitionID]++
		if log.writer == nil {
			continue
		}
		entry, err := entryFor(write, durable.handle.Name, uint32(partitionID), buffered.next[partitionID], held)
		if err != nil {
			return 0, durable.failPartition(log, err)
		}
		documentBytes += int64(len(entry.Document) + len(entry.PreviousDocument))
		entries = append(entries, entry)
	}
	if log.writer != nil && len(entries) > 0 {
		if err := log.writer.AppendAll(entries); err != nil {
			return 0, durable.failPartition(log, err)
		}
	}
	return documentBytes, nil
}

func (buffered *BufferedLog) Settle() {
	durable := buffered.durable
	durable.layoutMutex.RLock()
	defer durable.layoutMutex.RUnlock()
	for partitionID, log := range durable.partitions {
		if partitionID >= len(buffered.next) {
			continue
		}
		log.mutex.Lock()
		log.applied = max(log.applied, buffered.next[partitionID])
		log.mutex.Unlock()
	}
}
