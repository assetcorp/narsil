package persist

import (
	"context"
	"strconv"
	"strings"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type writeStall struct {
	mutex    sync.Mutex
	inFlight bool
	released chan struct{}
}

func (stall *writeStall) begin() {
	stall.mutex.Lock()
	defer stall.mutex.Unlock()
	stall.inFlight = true
	if stall.released == nil {
		stall.released = make(chan struct{})
	}
}

func (stall *writeStall) end() {
	stall.mutex.Lock()
	defer stall.mutex.Unlock()
	stall.inFlight = false
	if stall.released != nil {
		close(stall.released)
		stall.released = nil
	}
}

func (stall *writeStall) waiting() (<-chan struct{}, bool) {
	stall.mutex.Lock()
	defer stall.mutex.Unlock()
	if !stall.inFlight || stall.released == nil {
		return nil, false
	}
	return stall.released, true
}

func (durable *Durable) noteRecorded(records int, documentBytes int64) {
	durable.bytesSinceCheckpoint.Add(documentBytes)
	durable.manager.noteMutations(durable, records)
}

func (durable *Durable) checkpointDue(mutationThreshold int64) bool {
	if mutationThreshold > 0 && durable.sinceCheckpoint.Load() >= mutationThreshold {
		return true
	}
	return durable.bytesSinceCheckpoint.Load() >= WritesStallAboveUncheckpointedBytes
}

func (durable *Durable) noteCheckpointCommitted(records int64, documentBytes int64, left int64) {
	covered := max(0, records-left)
	if records > 0 && covered < records {
		documentBytes = int64(float64(documentBytes) * float64(covered) / float64(records))
	}
	durable.sinceCheckpoint.Add(-covered)
	durable.bytesSinceCheckpoint.Add(-documentBytes)
}

func (durable *Durable) stallWhileCheckpointsFallBehind(ctx context.Context) {
	for durable.bytesSinceCheckpoint.Load() >= WritesStallAboveUncheckpointedBytes && !durable.closed.Load() {
		released, stalled := durable.stall.waiting()
		if !stalled {
			return
		}
		select {
		case <-released:
		case <-ctx.Done():
			return
		}
	}
}

func (durable *Durable) failedPartitionIDs() []int {
	var failed []int
	durable.layoutMutex.RLock()
	defer durable.layoutMutex.RUnlock()
	for partitionID, log := range durable.partitions {
		log.mutex.Lock()
		if log.failed != nil {
			failed = append(failed, partitionID)
		}
		log.mutex.Unlock()
	}
	return failed
}

func joinedIDs(ids []int) string {
	parts := make([]string, len(ids))
	for at, id := range ids {
		parts[at] = strconv.Itoa(id)
	}
	return strings.Join(parts, ", ")
}

func (durable *Durable) refuseFailedPartitions() error {
	failed := durable.failedPartitionIDs()
	if len(failed) == 0 {
		return nil
	}
	return narsilerr.New(narsilerr.CodePersistenceSaveFailed,
		`Index "`+durable.handle.Name+`" cannot take a checkpoint that covers every acknowledged write, because partitions `+
			joinedIDs(failed)+" failed and have not recovered",
		map[string]any{"indexName": durable.handle.Name, "partitionIds": failed})
}

type HeldCheckpointReport struct {
	IndexName                    string
	PartitionIDs                 []int
	RecordsSinceCheckpoint       int64
	DocumentBytesSinceCheckpoint int64
}

func (manager *Manager) HeldCheckpoints() []HeldCheckpointReport {
	var held []HeldCheckpointReport
	for _, durable := range manager.snapshotIndexes() {
		failed := durable.failedPartitionIDs()
		if len(failed) == 0 || len(durable.handle.Vectors) == 0 {
			continue
		}
		held = append(held, HeldCheckpointReport{IndexName: durable.handle.Name, PartitionIDs: failed,
			RecordsSinceCheckpoint:       durable.sinceCheckpoint.Load(),
			DocumentBytesSinceCheckpoint: durable.bytesSinceCheckpoint.Load()})
	}
	return held
}
