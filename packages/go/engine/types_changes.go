package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

// ChangesSetting turns change capture on or off for an index, chooses
// whether each log entry holds the document before the write, and bounds the
// history that the engine keeps for the changes.
type ChangesSetting = model.ChangesSetting

// ChangesStatus reports the change capture setting of an index and its
// current epoch, which device sync shares.
type ChangesStatus = model.ChangesStatus

// ChangePosition is the highest sequence number of one partition that a
// subscriber has applied.
type ChangePosition = model.ChangePosition

// ChangesRequest asks Changes for the changes above a list of positions under
// an epoch, or from the present where it holds neither, and can hold a filter
// that chooses which changes to return.
type ChangesRequest = model.ChangesRequest

// ChangeType tells whether a change stores a document, inserts one, updates
// one, or removes one.
type ChangeType = model.ChangeType

const (
	// ChangePut stores a document that an entry without the previous document wrote.
	ChangePut = model.ChangePut
	// ChangeInsert stores a document under an ID that the partition did not hold.
	ChangeInsert = model.ChangeInsert
	// ChangeUpdate replaces the document under an ID.
	ChangeUpdate = model.ChangeUpdate
	// ChangeRemove removes the document under an ID.
	ChangeRemove = model.ChangeRemove
)

// Change is one insert, update, or removal, with the document after the write
// and, where the entry holds it, the document before the write.
type Change = model.Change

// ChangesSubscribed is the first result of Changes: the epoch, the positions
// that the changes start above, the heads of the partitions, and whether a
// change can hold the document before the write.
type ChangesSubscribed = model.ChangesSubscribed

// ChangeGroup holds the changes of one partition in sequence order, with the
// highest sequence number that the engine examined, which the caller saves as
// its position once it applies the changes.
type ChangeGroup = model.ChangeGroup

// ResyncReason tells why the caller must take a fresh document export.
type ResyncReason = model.ResyncReason

const (
	// ResyncEpoch reports a request under an epoch that the index no longer holds.
	ResyncEpoch = model.ResyncEpoch
	// ResyncHistory reports a position below the oldest change that the history holds.
	ResyncHistory = model.ResyncHistory
	// ResyncAhead reports a position above the highest change that the partition holds.
	ResyncAhead = model.ResyncAhead
)

// ChangesResync tells the caller to replace its copy with a document export
// and to request the changes from the export's epoch and positions.
type ChangesResync = model.ChangesResync

// ChangesEvent is one result of Changes, and exactly one of its fields is set.
type ChangesEvent = model.ChangesEvent
