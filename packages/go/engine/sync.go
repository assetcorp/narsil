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
)

type syncState struct {
	historyMaxAgeMs model.Optional[int64]
	historyMaxBytes model.Optional[int64]
	active          bool
	epoch           string
}

type indexSync struct {
	changeMu sync.Mutex
	state    atomic.Pointer[syncState]
}

func newSyncEpoch() string {
	bytes := make([]byte, syncEpochBytes)
	_, _ = rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func (held *indexSync) current() *syncState {
	return held.state.Load()
}

func (held *indexSync) archiveEpoch() model.Optional[string] {
	state := held.current()
	if state == nil {
		return model.Optional[string]{}
	}
	return model.Some(state.epoch)
}

func (held *indexSync) describe(meta *metadata.Metadata) {
	state := held.current()
	if state == nil {
		return
	}
	setting := &metadata.SyncSetting{Enabled: true}
	if age, set := state.historyMaxAgeMs.Get(); set {
		setting.HistoryMaxAgeMS = model.Some(uint64(age))
	}
	if size, set := state.historyMaxBytes.Get(); set {
		setting.HistoryMaxBytes = model.Some(uint64(size))
	}
	meta.Sync = setting
	meta.SyncActive = model.Some(state.active)
	meta.SyncEpoch = model.Some(state.epoch)
}

func syncStateOfMetadata(meta metadata.Metadata) *syncState {
	if meta.Sync == nil || !meta.Sync.Enabled {
		return nil
	}
	state := &syncState{}
	if age, set := meta.Sync.HistoryMaxAgeMS.Get(); set {
		state.historyMaxAgeMs = model.Some(int64(age))
	}
	if size, set := meta.Sync.HistoryMaxBytes.Get(); set {
		state.historyMaxBytes = model.Some(int64(size))
	}
	epoch, known := meta.SyncEpoch.Get()
	if !known || !metadata.IsSyncEpoch(epoch) {
		state.epoch = newSyncEpoch()
		return state
	}
	active, _ := meta.SyncActive.Get()
	state.epoch, state.active = epoch, active
	return state
}

func (held *indexSync) adopt(state *syncState) {
	held.state.Store(state)
}

func (held *indexSync) inheritRenewed(previous *indexEntry) {
	state := previous.sync.current()
	if state == nil {
		return
	}
	renewed := *state
	renewed.active, renewed.epoch = false, newSyncEpoch()
	held.state.Store(&renewed)
}

func syncLimitInvalid(name string, shown string) error {
	return narsilerr.New(narsilerr.CodeConfigInvalid, "The sync setting "+name+" must be a positive whole number",
		map[string]any{name: shown})
}

func requireSyncSetting(setting SyncSetting) (*syncState, error) {
	limits := &syncState{}
	if age, set := setting.HistoryMaxAge.Get(); set {
		whole := age%time.Millisecond == 0
		milliseconds := int64(age / time.Millisecond)
		if !whole || milliseconds < 1 || milliseconds > form.MaxSafeInteger {
			shown := strconv.FormatFloat(float64(age)/float64(time.Millisecond), 'f', -1, 64)
			return nil, syncLimitInvalid("historyMaxAgeMs", shown)
		}
		limits.historyMaxAgeMs = model.Some(milliseconds)
	}
	if size, set := setting.HistoryMaxBytes.Get(); set {
		if size < 1 || size > form.MaxSafeInteger {
			return nil, syncLimitInvalid("historyMaxBytes", strconv.FormatInt(size, 10))
		}
		limits.historyMaxBytes = model.Some(size)
	}
	return limits, nil
}

func requireNoQuerySuggestions(entry *indexEntry) error {
	meta, err := entry.metadataOf(0)
	if err != nil {
		return err
	}
	if setting := meta.QuerySuggestions.Setting; setting == nil || !setting.Enabled {
		return nil
	}
	return narsilerr.New(narsilerr.CodeConfigInvalid, `Index "`+entry.name+
		`" has popular query suggestions on, so it cannot sync to devices: a device receives the whole index of one user, while a suggestion comes from the searches of several people`,
		map[string]any{"indexName": entry.name})
}

func (n *Narsil) requireSyncStorage(entry *indexEntry) error {
	if n.filesystemDurability() && entry.durable != nil {
		return nil
	}
	return narsilerr.New(narsilerr.CodeSyncDurabilityRequired, `Index "`+entry.name+
		`" needs write-ahead log durability for device sync, because the feed reads the log`,
		map[string]any{"indexName": entry.name})
}

func persistSyncState(ctx context.Context, entry *indexEntry, next *syncState) error {
	previous := entry.sync.state.Swap(next)
	if entry.durable == nil {
		return nil
	}
	if err := entry.durable.PersistMetadata(ctx); err != nil {
		entry.sync.state.Store(previous)
		return err
	}
	return nil
}

func releaseSyncStorage(ctx context.Context, entry *indexEntry) error {
	if entry.durable == nil {
		return nil
	}
	return entry.durable.ReleaseSync(ctx)
}

// UpdateSync turns device sync on or off for the index called indexName, or
// changes its history limits. Turning sync on gives the index a new epoch,
// and turning it off deletes the kept history and the published snapshot.
// The call returns CONFIG_INVALID for a limit below 1 or for an index with
// popular query suggestions on, and SYNC_DURABILITY_REQUIRED when the engine
// has no write-ahead log durability. The engine writes the index metadata that
// holds the setting before it returns.
func (n *Narsil) UpdateSync(ctx context.Context, indexName string, setting SyncSetting) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	next, err := requireSyncSetting(setting)
	if err != nil {
		return err
	}
	if err := n.requireSyncStorage(entry); err != nil {
		return err
	}
	entry.sync.changeMu.Lock()
	defer entry.sync.changeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if setting.Enabled {
		if err := requireNoQuerySuggestions(entry); err != nil {
			return err
		}
	}
	previous := entry.sync.current()
	if !setting.Enabled {
		if previous == nil {
			return nil
		}
		if err := persistSyncState(ctx, entry, nil); err != nil {
			return err
		}
		return releaseSyncStorage(ctx, entry)
	}
	if previous != nil {
		next.active, next.epoch = previous.active, previous.epoch
		return persistSyncState(ctx, entry, next)
	}
	if err := releaseSyncStorage(ctx, entry); err != nil {
		return err
	}
	next.epoch = newSyncEpoch()
	return persistSyncState(ctx, entry, next)
}

// GetSync returns the device sync state of the index called indexName: off
// with no epoch, or on with its limits, whether a device has asked for the
// published snapshot, and the current epoch.
func (n *Narsil) GetSync(ctx context.Context, indexName string) (SyncStatus, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return SyncStatus{}, err
	}
	defer release()
	if err := ctx.Err(); err != nil {
		return SyncStatus{}, err
	}
	state := entry.sync.current()
	if state == nil {
		return SyncStatus{}, nil
	}
	status := SyncStatus{SyncSetting: SyncSetting{Enabled: true, HistoryMaxBytes: state.historyMaxBytes},
		Active: state.active, Epoch: state.epoch}
	if age, set := state.historyMaxAgeMs.Get(); set {
		status.HistoryMaxAge = model.Some(time.Duration(age) * time.Millisecond)
	}
	return status, nil
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
	renewed := *state
	renewed.active, renewed.epoch = false, newSyncEpoch()
	if err := persistSyncState(ctx, entry, &renewed); err != nil {
		entry.sync.changeMu.Unlock()
		return nil, err
	}
	if err := releaseSyncStorage(ctx, entry); err != nil {
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
	return releaseSyncStorage(ctx, entry)
}
