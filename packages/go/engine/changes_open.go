package engine

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

type changesFollower struct {
	n         *Narsil
	indexName string
	epoch     string
	positions []uint64
	filter    *FilterExpression
	next      int
}

func changesNotEnabled(indexName string) error {
	return narsilerr.New(narsilerr.CodeChangesNotEnabled, `Index "`+indexName+`" has change capture off`,
		map[string]any{"indexName": indexName})
}

func previousDocumentRequired(indexName string) error {
	return narsilerr.New(narsilerr.CodeChangesPreviousDocumentRequired, `Index "`+indexName+
		`" has previousDocument off, so a request for its changes can hold no filter`,
		map[string]any{"indexName": indexName})
}

func invalidPositions(indexName string, message string) error {
	return narsilerr.New(narsilerr.CodeChangesInvalidPositions, message, map[string]any{"indexName": indexName})
}

func resyncEvent(reason ResyncReason) ChangesEvent {
	return ChangesEvent{Resync: &ChangesResync{Reason: reason}}
}

func requireChangesRequest(indexName string, request ChangesRequest) error {
	epoch, hasEpoch := request.Epoch.Get()
	if hasEpoch != (request.Positions != nil) {
		return invalidPositions(indexName, "Pass the epoch and the positions together, or leave both out")
	}
	if hasEpoch && !metadata.IsSyncEpoch(epoch) {
		return invalidPositions(indexName, "The epoch must be 32 lowercase hexadecimal digits")
	}
	return nil
}

func seqNosByPartition(indexName string, positions []ChangePosition, partitionCount int) ([]uint64, error) {
	refused := invalidPositions(indexName, "The positions must hold each partition of the index once")
	if len(positions) != partitionCount {
		return nil, refused
	}
	seqNos := make([]uint64, partitionCount)
	seen := make([]bool, partitionCount)
	for _, position := range positions {
		if uint64(position.PartitionID) >= uint64(partitionCount) || seen[position.PartitionID] {
			return nil, refused
		}
		seen[position.PartitionID] = true
		seqNos[position.PartitionID] = position.SeqNo
	}
	return seqNos, nil
}

func positionList(seqNos []uint64) []ChangePosition {
	positions := make([]ChangePosition, len(seqNos))
	for partitionID, seqNo := range seqNos {
		positions[partitionID] = ChangePosition{PartitionID: uint32(partitionID), SeqNo: seqNo}
	}
	return positions
}

func (n *Narsil) openChanges(ctx context.Context, indexName string, request ChangesRequest) (*changesFollower,
	ChangesEvent, error) {
	entry, release, err := n.acquireContext(ctx, indexName)
	if err != nil {
		return nil, ChangesEvent{}, err
	}
	defer release()
	if err := requireChangesRequest(indexName, request); err != nil {
		return nil, ChangesEvent{}, err
	}
	entry.sync.changeMu.Lock()
	defer entry.sync.changeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, ChangesEvent{}, err
	}
	state, durable := entry.sync.current(), entry.durable
	if state == nil || state.changes == nil || durable == nil {
		return nil, ChangesEvent{}, changesNotEnabled(indexName)
	}
	if request.Filter != nil {
		if err := entry.index().ValidateFilter(request.Filter); err != nil {
			return nil, ChangesEvent{}, err
		}
		if !state.changes.previousDocument {
			return nil, ChangesEvent{}, previousDocumentRequired(indexName)
		}
	}
	count := durable.PartitionCount()
	var given []uint64
	if epoch, hasEpoch := request.Epoch.Get(); hasEpoch {
		if epoch != state.epoch {
			return nil, resyncEvent(ResyncEpoch), nil
		}
		if given, err = seqNosByPartition(indexName, request.Positions, count); err != nil {
			return nil, ChangesEvent{}, err
		}
	}
	heads, reason, err := partitionHeads(durable, given)
	if err != nil {
		return nil, ChangesEvent{}, err
	}
	if reason != "" {
		return nil, resyncEvent(reason), nil
	}
	seqNos := given
	if seqNos == nil {
		seqNos = append([]uint64(nil), heads...)
	}
	var behind uint64
	for partitionID, seqNo := range seqNos {
		bytes, err := durable.LogBytesAfter(partitionID, seqNo)
		if err != nil {
			return nil, ChangesEvent{}, err
		}
		behind += bytes
	}
	subscribed := &ChangesSubscribed{Epoch: state.epoch, PartitionCount: uint32(count), Positions: positionList(seqNos),
		Heads: positionList(heads), BytesBehind: behind, PreviousDocument: state.changes.previousDocument}
	follower := &changesFollower{n: n, indexName: indexName, epoch: state.epoch,
		positions: append([]uint64(nil), seqNos...), filter: request.Filter}
	return follower, ChangesEvent{Subscribed: subscribed}, nil
}

func partitionHeads(durable *persist.Durable, given []uint64) ([]uint64, ResyncReason, error) {
	count := durable.PartitionCount()
	heads := make([]uint64, count)
	for partitionID := range count {
		logState, err := durable.LogState(partitionID)
		if err != nil {
			return nil, "", err
		}
		if given != nil && logState.Oldest > 0 && given[partitionID] < logState.Oldest-1 {
			return nil, ResyncHistory, nil
		}
		if given != nil && given[partitionID] > logState.Highest {
			return nil, ResyncAhead, nil
		}
		heads[partitionID] = logState.Head
	}
	return heads, "", nil
}
