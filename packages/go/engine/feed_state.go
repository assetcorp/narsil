package engine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/metadata"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist"
)

type historyLimits struct {
	maxAgeMs model.Optional[int64]
	maxBytes model.Optional[int64]
}

type syncFeature struct {
	historyLimits
	active bool
}

type changesFeature struct {
	historyLimits
	previousDocument bool
}

type feedState struct {
	sync    *syncFeature
	changes *changesFeature
	epoch   string
}

type indexSync struct {
	changeMu sync.Mutex
	state    atomic.Pointer[feedState]
	changed  persist.Signal
}

func newSyncEpoch() string {
	bytes := make([]byte, syncEpochBytes)
	_, _ = rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func feedStateOf(syncOn *syncFeature, changesOn *changesFeature, epoch string) *feedState {
	if syncOn == nil && changesOn == nil {
		return nil
	}
	return &feedState{sync: syncOn, changes: changesOn, epoch: epoch}
}

func (held *indexSync) current() *feedState {
	return held.state.Load()
}

func (held *indexSync) syncOn() *syncFeature {
	if state := held.current(); state != nil {
		return state.sync
	}
	return nil
}

func (held *indexSync) changesOn() *changesFeature {
	if state := held.current(); state != nil {
		return state.changes
	}
	return nil
}

func (held *indexSync) recordsPreviousDocuments() bool {
	changes := held.changesOn()
	return changes != nil && changes.previousDocument
}

func (held *indexSync) archiveEpoch() model.Optional[string] {
	state := held.current()
	if state == nil {
		return model.Optional[string]{}
	}
	return model.Some(state.epoch)
}

func metadataLimit(limit model.Optional[int64]) model.Optional[uint64] {
	if value, set := limit.Get(); set {
		return model.Some(uint64(value))
	}
	return model.Optional[uint64]{}
}

func limitOfMetadata(limit model.Optional[uint64]) model.Optional[int64] {
	if value, set := limit.Get(); set {
		return model.Some(int64(value))
	}
	return model.Optional[int64]{}
}

func (held *indexSync) describe(meta *metadata.Metadata) {
	state := held.current()
	if state == nil {
		return
	}
	if state.sync != nil {
		meta.Sync = &metadata.SyncSetting{Enabled: true, HistoryMaxAgeMS: metadataLimit(state.sync.maxAgeMs),
			HistoryMaxBytes: metadataLimit(state.sync.maxBytes)}
		meta.SyncActive = model.Some(state.sync.active)
	}
	if state.changes != nil {
		meta.Changes = &metadata.ChangesSetting{Enabled: true, HistoryMaxAgeMS: metadataLimit(state.changes.maxAgeMs),
			HistoryMaxBytes: metadataLimit(state.changes.maxBytes)}
		if state.changes.previousDocument {
			meta.Changes.PreviousDocument = model.Some(true)
		}
	}
	meta.SyncEpoch = model.Some(state.epoch)
}

func feedStateOfMetadata(meta metadata.Metadata) *feedState {
	state := &feedState{}
	if meta.Sync != nil && meta.Sync.Enabled {
		state.sync = &syncFeature{historyLimits: historyLimits{maxAgeMs: limitOfMetadata(meta.Sync.HistoryMaxAgeMS),
			maxBytes: limitOfMetadata(meta.Sync.HistoryMaxBytes)}}
	}
	if meta.ChangesEnabled() {
		state.changes = &changesFeature{historyLimits: historyLimits{maxAgeMs: limitOfMetadata(meta.Changes.HistoryMaxAgeMS),
			maxBytes: limitOfMetadata(meta.Changes.HistoryMaxBytes)}, previousDocument: meta.Changes.PreviousDocument.Or(false)}
	}
	if state.sync == nil && state.changes == nil {
		return nil
	}
	epoch, known := meta.SyncEpoch.Get()
	if !known || !metadata.IsSyncEpoch(epoch) {
		state.epoch = newSyncEpoch()
		return state
	}
	state.epoch = epoch
	if state.sync != nil {
		state.sync.active, _ = meta.SyncActive.Get()
	}
	return state
}

func (held *indexSync) adopt(state *feedState) {
	held.state.Store(state)
}

func (state *feedState) renewed() *feedState {
	renewed := &feedState{changes: state.changes, epoch: newSyncEpoch()}
	if state.sync != nil {
		inactive := *state.sync
		inactive.active = false
		renewed.sync = &inactive
	}
	return renewed
}

func (held *indexSync) inheritRenewed(previous *indexEntry) {
	if state := previous.sync.current(); state != nil {
		held.state.Store(state.renewed())
	}
}

func historyLimitInvalid(setting string, name string, shown string) error {
	return narsilerr.New(narsilerr.CodeConfigInvalid, "The "+setting+" setting "+name+" must be a positive whole number",
		map[string]any{name: shown})
}

func requireHistoryLimits(setting string, age model.Optional[time.Duration], size model.Optional[int64]) (historyLimits,
	error) {
	var limits historyLimits
	if maxAge, set := age.Get(); set {
		whole := maxAge%time.Millisecond == 0
		milliseconds := int64(maxAge / time.Millisecond)
		if !whole || milliseconds < 1 || milliseconds > form.MaxSafeInteger {
			shown := strconv.FormatFloat(float64(maxAge)/float64(time.Millisecond), 'f', -1, 64)
			return historyLimits{}, historyLimitInvalid(setting, "historyMaxAgeMs", shown)
		}
		limits.maxAgeMs = model.Some(milliseconds)
	}
	if maxBytes, set := size.Get(); set {
		if maxBytes < 1 || maxBytes > form.MaxSafeInteger {
			return historyLimits{}, historyLimitInvalid(setting, "historyMaxBytes", strconv.FormatInt(maxBytes, 10))
		}
		limits.maxBytes = model.Some(maxBytes)
	}
	return limits, nil
}

func (limits historyLimits) maxAge() model.Optional[time.Duration] {
	if age, set := limits.maxAgeMs.Get(); set {
		return model.Some(time.Duration(age) * time.Millisecond)
	}
	return model.Optional[time.Duration]{}
}

func persistFeedState(ctx context.Context, entry *indexEntry, next *feedState) error {
	previous := entry.sync.state.Swap(next)
	if entry.durable != nil {
		if err := entry.durable.PersistMetadata(ctx); err != nil {
			entry.sync.state.Store(previous)
			return err
		}
	}
	entry.sync.changed.Notify()
	return nil
}

func releaseFeedStorage(ctx context.Context, entry *indexEntry, keepHistory bool) error {
	if entry.durable == nil {
		return nil
	}
	return entry.durable.ReleaseSync(ctx, keepHistory)
}

func (n *Narsil) holdRenewedSyncEpoch(ctx context.Context, entry *indexEntry) (func(), error) {
	if entry.sync.current() == nil {
		return func() {}, nil
	}
	entry.sync.changeMu.Lock()
	state := entry.sync.current()
	if state == nil {
		return entry.sync.changeMu.Unlock, nil
	}
	if err := persistFeedState(ctx, entry, state.renewed()); err != nil {
		entry.sync.changeMu.Unlock()
		return nil, err
	}
	if err := releaseFeedStorage(ctx, entry, false); err != nil {
		entry.sync.changeMu.Unlock()
		return nil, err
	}
	return entry.sync.changeMu.Unlock, nil
}

func (n *Narsil) inheritSync(created *indexEntry) {
	if previous, found := n.lookup(created.name); found {
		created.sync.inheritRenewed(previous)
	}
}

func (n *Narsil) releaseInheritedSync(ctx context.Context, entry *indexEntry) error {
	if entry.sync.current() == nil {
		return nil
	}
	entry.sync.changeMu.Lock()
	defer entry.sync.changeMu.Unlock()
	return releaseFeedStorage(ctx, entry, false)
}
