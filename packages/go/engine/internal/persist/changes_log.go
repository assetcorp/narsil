package persist

import (
	"sort"
	"strconv"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/writeahead"
)

type Signal struct {
	mutex   sync.Mutex
	changed chan struct{}
}

func (signal *Signal) Notify() {
	signal.mutex.Lock()
	defer signal.mutex.Unlock()
	if signal.changed != nil {
		close(signal.changed)
		signal.changed = nil
	}
}

func (signal *Signal) Next() <-chan struct{} {
	signal.mutex.Lock()
	defer signal.mutex.Unlock()
	if signal.changed == nil {
		signal.changed = make(chan struct{})
	}
	return signal.changed
}

func (durable *Durable) HeadsChanged() <-chan struct{} {
	return durable.heads.Next()
}

type PartitionLogState struct {
	Head    uint64
	Highest uint64
	Oldest  uint64
}

type feedSegment struct {
	partition  uint32
	start      uint64
	walKey     string
	historyKey string
}

func (durable *Durable) PartitionCount() int {
	durable.layoutMutex.RLock()
	defer durable.layoutMutex.RUnlock()
	return len(durable.partitions)
}

func (durable *Durable) LogState(partitionID int) (PartitionLogState, error) {
	directory, name := durable.manager.directory, durable.handle.Name
	if directory == nil || partitionID < 0 || partitionID >= durable.PartitionCount() {
		return PartitionLogState{}, narsilerr.New(narsilerr.CodePersistenceLoadFailed,
			`Index "`+name+`" holds no write-ahead log for partition `+strconv.Itoa(partitionID),
			map[string]any{"indexName": name, "partitionId": partitionID})
	}
	highest := durable.AppliedSeqNo(partitionID)
	state := PartitionLogState{Head: highest, Highest: highest}
	bounds, err := writeahead.ReadBounds(directory, name, uint32(partitionID))
	if err != nil {
		return PartitionLogState{}, err
	}
	if bounds.Found {
		state.Head = min(bounds.HighestDurableSeqNo, highest)
	}
	segments, err := durable.feedSegments(uint32(partitionID))
	if err != nil {
		return PartitionLogState{}, err
	}
	state.Oldest = state.Head + 1
	if len(segments) > 0 {
		state.Oldest = min(segments[0].start, state.Oldest)
	}
	return state, nil
}

func (durable *Durable) feedSegments(partitionID uint32) ([]feedSegment, error) {
	directory, name := durable.manager.directory, durable.handle.Name
	logged, err := writeahead.ListSegments(directory, name, partitionID)
	if err != nil {
		return nil, err
	}
	keys, err := directory.List(historyPrefix(name, partitionID))
	if err != nil {
		return nil, err
	}
	byStart := map[uint64]*feedSegment{}
	for _, key := range keys {
		if moved, ok := parseHistoryKey(name, key); ok && moved.partition == partitionID {
			byStart[moved.startSeqNo] = &feedSegment{partition: partitionID, start: moved.startSeqNo, historyKey: key}
		}
	}
	for _, segment := range logged {
		if held, found := byStart[segment.StartSeqNo]; found {
			held.walKey = segment.Key
			continue
		}
		byStart[segment.StartSeqNo] = &feedSegment{partition: partitionID, start: segment.StartSeqNo, walKey: segment.Key}
	}
	segments := make([]feedSegment, 0, len(byStart))
	for _, segment := range byStart {
		segments = append(segments, *segment)
	}
	sort.Slice(segments, func(left, right int) bool { return segments[left].start < segments[right].start })
	return segments, nil
}
