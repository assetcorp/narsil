package persist

import (
	"context"
	"sort"
	"sync"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/writeahead"
)

type partitionLog struct {
	mutex         sync.Mutex
	writer        *writeahead.Writer
	applied       uint64
	failed        error
	clearsCovered uint64
}

type Durable struct {
	manager              *Manager
	handle               *Handle
	partitions           []*partitionLog
	layoutMutex          sync.RWMutex
	checkpointMutex      sync.Mutex
	metadataMutex        sync.Mutex
	sinceCheckpoint      atomic.Int64
	bytesSinceCheckpoint atomic.Int64
	heldFiles            atomic.Int32
	closed               atomic.Bool
	stall                writeStall
}

func (manager *Manager) newDurable(handle *Handle, applied []uint64) *Durable {
	durable := &Durable{manager: manager, handle: handle}
	count := handle.Index.PartitionCount()
	durable.partitions = make([]*partitionLog, count)
	for partitionID := range durable.partitions {
		log := &partitionLog{}
		if partitionID < len(applied) {
			log.applied = applied[partitionID]
		}
		if manager.logged() {
			log.writer = writeahead.NewWriter(writeahead.Config{Directory: manager.directory,
				IndexName: handle.Name, PartitionID: uint32(partitionID),
				SegmentMaxBytes: manager.settings.SegmentMaxBytes})
		}
		durable.partitions[partitionID] = log
	}
	return durable
}

func (durable *Durable) Handle() *Handle {
	return durable.handle
}

func (manager *Manager) Create(ctx context.Context, handle *Handle) (*Durable, error) {
	if err := manager.Fatal(); err != nil {
		return nil, err
	}
	if _, found, err := manager.store.Size(ctx, metadataKey(handle.Name)); err != nil {
		return nil, err
	} else if found {
		return nil, narsilerr.New(narsilerr.CodeIndexAlreadyExists,
			`Index "`+handle.Name+`" already holds durable data`, map[string]any{"indexName": handle.Name})
	}
	durable := manager.newDurable(handle, nil)
	if err := manager.register(durable); err != nil {
		return nil, err
	}
	if err := durable.writeMetadata(ctx, uint64(handle.Index.Count())); err != nil {
		manager.unregister(handle.Name)
		return nil, err
	}
	return durable, nil
}

func metadataKey(name string) string {
	return name + "/meta"
}

func (durable *Durable) writeMetadata(ctx context.Context, documentCount uint64) error {
	durable.metadataMutex.Lock()
	defer durable.metadataMutex.Unlock()
	meta, err := durable.handle.metadata(documentCount)
	if err != nil {
		return err
	}
	return durable.storeMetadata(ctx, meta)
}

func (durable *Durable) storeMetadata(ctx context.Context, meta metadata.Metadata) error {
	encoded, err := metadata.Write(meta, false, true)
	if err != nil {
		return err
	}
	return durable.manager.store.Write(ctx, metadataKey(durable.handle.Name), encoded)
}

func (durable *Durable) refuseWrites() error {
	if durable.closed.Load() {
		return narsilerr.New(narsilerr.CodeInstanceShutDown,
			`Index "`+durable.handle.Name+`" is closed`, map[string]any{"indexName": durable.handle.Name})
	}
	return durable.manager.Fatal()
}

func (durable *Durable) Apply(ctx context.Context, writes []Write) ([]error, error) {
	if err := durable.refuseWrites(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	groups := map[int][]int{}
	for at, write := range writes {
		partitionID := durable.handle.Index.RoutePartition(write.DocumentID)
		groups[partitionID] = append(groups[partitionID], at)
	}
	order := make([]int, 0, len(groups))
	for partitionID := range groups {
		order = append(order, partitionID)
	}
	sort.Ints(order)
	failures := make([]error, len(writes))
	var touched []*partitionLog
	applied := 0
	var documentBytes int64
	for _, partitionID := range order {
		members := groups[partitionID]
		group := make([]Write, len(members))
		for at, member := range members {
			group[at] = writes[member]
		}
		log := durable.partitions[partitionID]
		outcomes, logged, err := durable.applyLogged(ctx, log, partitionID, group)
		if err != nil {
			return nil, err
		}
		documentBytes += logged
		for at, member := range members {
			failures[member] = outcomes[at]
			if outcomes[at] == nil {
				applied++
			}
		}
		touched = append(touched, log)
	}
	if err := durable.commit(touched); err != nil {
		return nil, err
	}
	durable.noteRecorded(applied, documentBytes)
	durable.stallWhileCheckpointsFallBehind(ctx)
	return failures, nil
}

func (durable *Durable) applyLogged(ctx context.Context, log *partitionLog, partitionID int, group []Write) ([]error,
	int64, error) {
	log.mutex.Lock()
	defer log.mutex.Unlock()
	if log.failed != nil {
		return nil, 0, log.failed
	}
	outcomes, err := durable.handle.apply(ctx, group)
	if err != nil {
		return nil, 0, err
	}
	var entries []wal.Entry
	var documentBytes int64
	for at, write := range group {
		if outcomes[at] != nil {
			continue
		}
		log.applied++
		if log.writer == nil {
			continue
		}
		entry, err := entryFor(write, durable.handle.Name, uint32(partitionID), log.applied)
		if err != nil {
			return nil, 0, durable.failPartition(log, err)
		}
		documentBytes += int64(len(entry.Document))
		entries = append(entries, entry)
	}
	if log.writer != nil && len(entries) > 0 {
		if err := log.writer.AppendAll(entries); err != nil {
			return nil, 0, durable.failPartition(log, err)
		}
	}
	return outcomes, documentBytes, nil
}

func (durable *Durable) failPartition(log *partitionLog, cause error) error {
	failure := narsilerr.Passthrough(cause, narsilerr.CodePersistenceSaveFailed,
		`The write-ahead log of index "`+durable.handle.Name+`" failed`)
	log.failed = failure
	durable.manager.markFatal(failure)
	return failure
}

func (durable *Durable) commit(touched []*partitionLog) error {
	if !durable.manager.logged() || durable.manager.settings.Mode != ModeSync || len(touched) == 0 {
		return nil
	}
	errs := make([]error, len(touched))
	if len(touched) == 1 {
		errs[0] = touched[0].writer.Commit()
	} else {
		var waiting sync.WaitGroup
		for at, log := range touched {
			waiting.Add(1)
			go func() {
				defer waiting.Done()
				errs[at] = log.writer.Commit()
			}()
		}
		waiting.Wait()
	}
	for at, err := range errs {
		if err != nil {
			touched[at].mutex.Lock()
			failure := durable.failPartition(touched[at], err)
			touched[at].mutex.Unlock()
			return failure
		}
	}
	return durable.manager.verifyDirectory()
}

func (durable *Durable) flush() error {
	durable.layoutMutex.RLock()
	defer durable.layoutMutex.RUnlock()
	for _, log := range durable.partitions {
		if log.writer == nil {
			continue
		}
		if err := log.writer.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func (durable *Durable) AppliedSeqNo(partitionID int) uint64 {
	durable.layoutMutex.RLock()
	defer durable.layoutMutex.RUnlock()
	log := durable.partitions[partitionID]
	log.mutex.Lock()
	defer log.mutex.Unlock()
	return log.applied
}

func (durable *Durable) close() error {
	if durable.closed.Swap(true) {
		return nil
	}
	durable.checkpointMutex.Lock()
	defer durable.checkpointMutex.Unlock()
	var first error
	for _, log := range durable.partitions {
		log.mutex.Lock()
		if log.writer != nil {
			if err := log.writer.Close(); err != nil && first == nil {
				first = err
			}
		}
		log.mutex.Unlock()
	}
	return first
}

func (durable *Durable) Close(ctx context.Context) error {
	err := durable.close()
	durable.manager.unregister(durable.handle.Name)
	if ctxErr := ctx.Err(); ctxErr != nil && err == nil {
		err = ctxErr
	}
	return err
}

func (durable *Durable) Drop(ctx context.Context) error {
	err := durable.close()
	for _, log := range durable.partitions {
		if log.writer != nil {
			log.writer.Abandon()
		}
	}
	durable.manager.unregister(durable.handle.Name)
	if removeErr := durable.manager.removeIndexKeys(ctx, durable.handle.Name); removeErr != nil {
		return removeErr
	}
	return err
}
