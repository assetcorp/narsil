package changes

import (
	"math"
	"regexp"

	narsil "github.com/assetcorp/narsil/packages/go"
)

var epochPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

var resyncReasons = map[string]bool{"epoch": true, "history": true, "ahead": true}

var changeTypes = map[ChangeType]bool{ChangePut: true, ChangeInsert: true, ChangeUpdate: true, ChangeRemove: true}

type feedState struct {
	partitionCount uint32
	scanned        []uint64
}

func malformed(detail string) *narsil.Error {
	return narsil.NewError(narsil.CodeClientInvalidResponse, "The change feed sent a malformed message: "+detail, nil, nil)
}

func countOf(value any) (uint64, bool) {
	switch typed := value.(type) {
	case int64:
		return uint64(typed), typed >= 0
	case uint64:
		return typed, true
	}
	return 0, false
}

func positionsOf(raw any, partitionCount uint32, field string) ([]Position, error) {
	items, ok := raw.([]any)
	if !ok || uint64(len(items)) != uint64(partitionCount) {
		return nil, malformed(field + " must hold each partition once")
	}
	seen := make([]bool, partitionCount)
	positions := make([]Position, 0, len(items))
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			return nil, malformed(field + " is invalid")
		}
		partitionID, partitionOK := countOf(entry["partitionId"])
		seqNo, seqNoOK := countOf(entry["seqNo"])
		if !partitionOK || !seqNoOK {
			return nil, malformed(field + " is invalid")
		}
		if partitionID >= uint64(partitionCount) || seen[partitionID] {
			return nil, malformed(field + " must hold each partition once")
		}
		seen[partitionID] = true
		positions = append(positions, Position{PartitionID: uint32(partitionID), SeqNo: seqNo})
	}
	return positions, nil
}

func documentOf(raw any, field string) (narsil.AnyDocument, error) {
	if raw == nil {
		return nil, nil
	}
	document, ok := raw.(map[string]any)
	if !ok {
		return nil, malformed(field + " must be a map")
	}
	return document, nil
}

func changeOf(raw any) (Change, error) {
	entry, ok := raw.(map[string]any)
	if !ok {
		return Change{}, malformed("a change is invalid")
	}
	seqNo, seqNoOK := countOf(entry["seqNo"])
	documentID, idOK := entry["documentId"].(string)
	if !seqNoOK || !idOK {
		return Change{}, malformed("a change is invalid")
	}
	kind, _ := entry["type"].(string)
	if !changeTypes[ChangeType(kind)] {
		return Change{}, malformed("a change has an unknown type")
	}
	document, err := documentOf(entry["document"], "document")
	if err != nil {
		return Change{}, err
	}
	previous, err := documentOf(entry["previousDocument"], "previousDocument")
	if err != nil {
		return Change{}, err
	}
	if (document == nil) != (ChangeType(kind) == ChangeRemove) {
		return Change{}, malformed("a change of type " + kind + " has the wrong documents")
	}
	return Change{SeqNo: seqNo, Type: ChangeType(kind), DocumentID: documentID, Document: document, PreviousDocument: previous}, nil
}

func subscribedOf(raw any) (*Subscribed, *feedState, error) {
	message, ok := raw.(map[string]any)
	if !ok || message["type"] != "subscribed" {
		return nil, nil, malformed("the first message must be subscribed")
	}
	epoch, ok := message["epoch"].(string)
	if !ok || !epochPattern.MatchString(epoch) {
		return nil, nil, malformed("the epoch is invalid")
	}
	partitionCount, ok := countOf(message["partitionCount"])
	if !ok || partitionCount == 0 || partitionCount > math.MaxUint32 {
		return nil, nil, malformed("the partition count is invalid")
	}
	bytesBehind, behindOK := countOf(message["bytesBehind"])
	windowBytes, windowOK := countOf(message["windowBytes"])
	if !behindOK || !windowOK || windowBytes == 0 {
		return nil, nil, malformed("a byte count is invalid")
	}
	previousDocument, ok := message["previousDocument"].(bool)
	if !ok {
		return nil, nil, malformed("previousDocument must be a boolean")
	}
	count := uint32(partitionCount)
	positions, err := positionsOf(message["positions"], count, "positions")
	if err != nil {
		return nil, nil, err
	}
	heads, err := positionsOf(message["heads"], count, "heads")
	if err != nil {
		return nil, nil, err
	}
	state := &feedState{partitionCount: count, scanned: make([]uint64, count)}
	for _, position := range positions {
		state.scanned[position.PartitionID] = position.SeqNo
	}
	return &Subscribed{
		Epoch: epoch, PartitionCount: count, Positions: positions, Heads: heads,
		BytesBehind: bytesBehind, WindowBytes: windowBytes, PreviousDocument: previousDocument,
	}, state, nil
}

func laterEventOf(raw any, state *feedState) (Event, error) {
	message, ok := raw.(map[string]any)
	if !ok {
		return nil, malformed("a message must be a map")
	}
	switch message["type"] {
	case "resync":
		reason, _ := message["reason"].(string)
		if !resyncReasons[reason] {
			return nil, malformed("the resync reason is unknown")
		}
		return &Resync{Reason: reason}, nil
	case "changes":
		return batchOf(message, state)
	}
	return nil, malformed("the message type is unknown")
}

func batchOf(message map[string]any, state *feedState) (*Batch, error) {
	partitionID, ok := countOf(message["partitionId"])
	if !ok || partitionID >= uint64(state.partitionCount) {
		return nil, malformed("the partition is unknown")
	}
	scannedSeqNo, scannedOK := countOf(message["scannedSeqNo"])
	items, itemsOK := message["changes"].([]any)
	if !scannedOK || !itemsOK {
		return nil, malformed("the changes are invalid")
	}
	floor := state.scanned[partitionID]
	if scannedSeqNo < floor {
		return nil, malformed("scannedSeqNo moved backwards")
	}
	changes := make([]Change, 0, len(items))
	for _, item := range items {
		change, err := changeOf(item)
		if err != nil {
			return nil, err
		}
		if change.SeqNo <= floor || change.SeqNo > scannedSeqNo {
			return nil, malformed("a change lies outside the partition's order")
		}
		floor = change.SeqNo
		changes = append(changes, change)
	}
	state.scanned[partitionID] = scannedSeqNo
	return &Batch{PartitionID: uint32(partitionID), Changes: changes, ScannedSeqNo: scannedSeqNo}, nil
}
