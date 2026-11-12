package engine

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func (n *Narsil) requireChangesStorage(entry *indexEntry) error {
	if n.filesystemDurability() && entry.durable != nil {
		return nil
	}
	return narsilerr.New(narsilerr.CodeChangesDurabilityRequired, `Index "`+entry.name+
		`" needs write-ahead log durability for change capture, because the feed reads the log`,
		map[string]any{"indexName": entry.name})
}

// UpdateChanges replaces the change capture setting of the index called
// indexName. Turning capture on gives the index a new epoch unless device sync
// is on, and from then on every checkpoint keeps the log segments that it
// covers as history. Turning capture off ends every Changes iteration of the
// index and deletes the history unless a device has asked for the index's sync
// snapshot. A change of PreviousDocument applies to every later write and keeps
// the epoch. The call returns CHANGES_DURABILITY_REQUIRED when the engine has no
// write-ahead log durability, and CONFIG_INVALID for a history limit that is
// not a positive whole number of milliseconds or bytes. The engine writes the
// index metadata that holds the setting before it returns, and no snapshot of
// the index holds the setting.
func (n *Narsil) UpdateChanges(ctx context.Context, indexName string, setting ChangesSetting) error {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return err
	}
	defer release()
	limits, err := requireHistoryLimits("changes", setting.HistoryMaxAge, setting.HistoryMaxBytes)
	if err != nil {
		return err
	}
	if err := n.requireChangesStorage(entry); err != nil {
		return err
	}
	entry.sync.changeMu.Lock()
	defer entry.sync.changeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	previous := entry.sync.current()
	if !setting.Enabled {
		return turnChangesOff(ctx, entry, previous)
	}
	enabled := &changesFeature{historyLimits: limits, previousDocument: setting.PreviousDocument}
	if previous != nil {
		return persistFeedState(ctx, entry, feedStateOf(previous.sync, enabled, previous.epoch))
	}
	if err := releaseFeedStorage(ctx, entry, false); err != nil {
		return err
	}
	return persistFeedState(ctx, entry, feedStateOf(nil, enabled, newSyncEpoch()))
}

func turnChangesOff(ctx context.Context, entry *indexEntry, previous *feedState) error {
	if previous == nil || previous.changes == nil {
		return nil
	}
	if err := persistFeedState(ctx, entry, feedStateOf(previous.sync, nil, previous.epoch)); err != nil {
		return err
	}
	if previous.sync != nil && previous.sync.active {
		return nil
	}
	return entry.durable.RemoveHistory(ctx)
}

// GetChanges returns the change capture state of the index called indexName:
// off with no epoch, or on with its setting and the current epoch, which
// device sync shares.
func (n *Narsil) GetChanges(ctx context.Context, indexName string) (ChangesStatus, error) {
	entry, release, err := n.acquire(indexName)
	if err != nil {
		return ChangesStatus{}, err
	}
	defer release()
	if err := ctx.Err(); err != nil {
		return ChangesStatus{}, err
	}
	state := entry.sync.current()
	if state == nil || state.changes == nil {
		return ChangesStatus{}, nil
	}
	return ChangesStatus{ChangesSetting: ChangesSetting{Enabled: true, PreviousDocument: state.changes.previousDocument,
		HistoryMaxAge: state.changes.maxAge(), HistoryMaxBytes: state.changes.maxBytes}, Epoch: state.epoch}, nil
}
