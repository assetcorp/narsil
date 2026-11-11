package engine

import (
	"context"
	"iter"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/wal"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

// Changes returns the changes of the index called indexName above the
// positions in request, and then each later change once the log holds it
// durably, until ctx ends or the caller stops the iteration.
//
// The first event holds a ChangesSubscribed with the epoch, the positions
// that the changes start above, and the heads of the partitions. A request
// without an epoch and positions starts at the heads. Each later event holds
// a ChangeGroup with the changes of one partition in sequence order. Apply its
// changes, then save its ScannedSeqNo as the partition's position. Under a
// filter, a group can hold no changes, and its ScannedSeqNo still rises. Where
// the positions no longer lead to the index's changes, the last event holds a
// ChangesResync: take a document export, replace your copy with its
// documents, and request the changes again from the export's epoch and
// positions.
//
// The iteration yields an error and ends with CHANGES_NOT_ENABLED when change
// capture is off or turns off, with CHANGES_INVALID_POSITIONS for a malformed
// epoch or list of positions, with SEARCH_INVALID_FILTER for a filter outside
// the shape and the limits of a query's filters, with
// CHANGES_PREVIOUS_DOCUMENT_REQUIRED for a filter while PreviousDocument is
// off or turns off, and with the error of ctx when ctx ends.
func (n *Narsil) Changes(ctx context.Context, indexName string, request ChangesRequest) iter.Seq2[ChangesEvent, error] {
	return func(yield func(ChangesEvent, error) bool) {
		follower, first, err := n.openChanges(ctx, indexName, request)
		if err != nil {
			yield(ChangesEvent{}, err)
			return
		}
		if !yield(first, nil) || follower == nil {
			return
		}
		follower.follow(ctx, yield)
	}
}

type changesStep struct {
	event   *ChangesEvent
	heads   <-chan struct{}
	changed <-chan struct{}
}

func (follower *changesFollower) follow(ctx context.Context, yield func(ChangesEvent, error) bool) {
	idle := time.NewTimer(changesIdleRecheckInterval)
	defer idle.Stop()
	for {
		if err := ctx.Err(); err != nil {
			yield(ChangesEvent{}, err)
			return
		}
		step, err := follower.step(ctx)
		if err != nil {
			yield(ChangesEvent{}, err)
			return
		}
		if step.event != nil {
			if !yield(*step.event, nil) || step.event.Resync != nil {
				return
			}
			continue
		}
		idle.Reset(changesIdleRecheckInterval)
		select {
		case <-ctx.Done():
		case <-step.heads:
		case <-step.changed:
		case <-idle.C:
		}
	}
}

func (follower *changesFollower) step(ctx context.Context) (changesStep, error) {
	entry, _, release, err := follower.n.acquireWithoutReopen(follower.indexName)
	if err != nil {
		return changesStep{}, err
	}
	defer release()
	if entry == nil {
		return changesStep{}, nil
	}
	entry.sync.changeMu.Lock()
	defer entry.sync.changeMu.Unlock()
	state, durable := entry.sync.current(), entry.durable
	if state == nil || state.changes == nil || durable == nil {
		return changesStep{}, changesNotEnabled(follower.indexName)
	}
	count := len(follower.positions)
	if state.epoch != follower.epoch || durable.PartitionCount() != count {
		resync := resyncEvent(ResyncEpoch)
		return changesStep{event: &resync}, nil
	}
	if follower.filter != nil && !state.changes.previousDocument {
		return changesStep{}, previousDocumentRequired(follower.indexName)
	}
	waits := changesStep{heads: durable.HeadsChanged(), changed: entry.sync.changed.Next()}
	for offset := range count {
		partitionID := (follower.next + offset) % count
		event, err := follower.readGroup(ctx, durable, partitionID)
		if err != nil {
			return changesStep{}, err
		}
		if event != nil {
			follower.next = (partitionID + 1) % count
			return changesStep{event: event}, nil
		}
	}
	return waits, nil
}

func (follower *changesFollower) readGroup(ctx context.Context, durable *persist.Durable, partitionID int) (
	*ChangesEvent, error) {
	after := follower.positions[partitionID]
	logState, err := durable.LogState(partitionID)
	if err != nil || logState.Head <= after {
		return nil, err
	}
	chunk, err := durable.ReadLogChunk(ctx, partitionID, after, logState.Head,
		persist.LogChunkLimits{MaxBytes: maxChangeGroupBytes, MaxEntries: maxChangeGroupEntries})
	if err != nil {
		return nil, err
	}
	if chunk.Gap {
		current, err := durable.LogState(partitionID)
		if err != nil || current.Oldest == 0 || after >= current.Oldest-1 {
			return nil, err
		}
		resync := resyncEvent(ResyncHistory)
		return &resync, nil
	}
	changes, err := follower.changesOf(ctx, durable, chunk.Entries)
	if err != nil {
		return nil, err
	}
	scanned := chunk.Entries[len(chunk.Entries)-1].SeqNo
	follower.positions[partitionID] = scanned
	return &ChangesEvent{Group: &ChangeGroup{PartitionID: uint32(partitionID), Changes: changes, ScannedSeqNo: scanned}},
		nil
}

func (follower *changesFollower) changesOf(ctx context.Context, durable *persist.Durable, entries []wal.Entry) (
	[]Change, error) {
	var matches []persist.FilterMatch
	if follower.filter != nil {
		var err error
		if matches, err = durable.MatchFilter(ctx, follower.filter, entries); err != nil {
			return nil, err
		}
	}
	changes := make([]Change, 0, len(entries))
	for at, entry := range entries {
		derived, kept := derivedChangeOf(entry), true
		if matches != nil {
			derived, kept = filteredChangeOf(entry, matches[at])
		}
		if !kept {
			continue
		}
		change, err := derived.decoded(durable)
		if err != nil {
			return nil, err
		}
		changes = append(changes, change)
	}
	return changes, nil
}
