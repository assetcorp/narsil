package engine

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

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

// UpdateSync turns device sync on or off for the index called indexName, or
// changes its history limits. Turning sync on gives the index a new epoch
// unless change capture is on, and turning it off deletes the published
// snapshot and, unless change capture is on, the kept history. The call
// returns CONFIG_INVALID for a limit below 1 or for an index with popular
// query suggestions on, and SYNC_DURABILITY_REQUIRED when the engine has no
// write-ahead log durability. The engine writes the index metadata that holds
// the setting before it returns.
func (n *Narsil) UpdateSync(ctx context.Context, indexName string, setting SyncSetting) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	limits, err := requireHistoryLimits("sync", setting.HistoryMaxAge, setting.HistoryMaxBytes)
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
		if previous == nil || previous.sync == nil {
			return nil
		}
		next := feedStateOf(nil, previous.changes, previous.epoch)
		if err := persistFeedState(ctx, entry, next); err != nil {
			return err
		}
		return releaseFeedStorage(ctx, entry, next != nil)
	}
	enabled := &syncFeature{historyLimits: limits}
	if previous != nil && previous.sync != nil {
		enabled.active = previous.sync.active
		return persistFeedState(ctx, entry, feedStateOf(enabled, previous.changes, previous.epoch))
	}
	if previous != nil {
		return persistFeedState(ctx, entry, feedStateOf(enabled, previous.changes, previous.epoch))
	}
	if err := releaseFeedStorage(ctx, entry, false); err != nil {
		return err
	}
	return persistFeedState(ctx, entry, feedStateOf(enabled, nil, newSyncEpoch()))
}

// GetSync returns the device sync state of the index called indexName: off
// with no epoch, or on with its limits, whether a device has asked for the
// published snapshot, and the current epoch, which change capture shares.
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
	if state == nil || state.sync == nil {
		return SyncStatus{}, nil
	}
	return SyncStatus{SyncSetting: SyncSetting{Enabled: true, HistoryMaxAge: state.sync.maxAge(),
		HistoryMaxBytes: state.sync.maxBytes}, Active: state.sync.active, Epoch: state.epoch}, nil
}
