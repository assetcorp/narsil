package changes

import narsil "github.com/assetcorp/narsil/packages/go"

// Position is a subscriber's place in one partition of an index: the highest seqNo whose change it has
// applied.
type Position struct {
	// PartitionID is the partition that the position belongs to.
	PartitionID uint32
	// SeqNo is the sequence number of the last log entry that the subscriber has examined there.
	SeqNo uint64
}

// ChangeType says what a write did to a document.
type ChangeType string

// The four kinds of change. A put comes from a log entry that the server wrote while previousDocument
// was off, so it can be an insert or an update.
const (
	ChangePut    ChangeType = "put"
	ChangeInsert ChangeType = "insert"
	ChangeUpdate ChangeType = "update"
	ChangeRemove ChangeType = "remove"
)

// Change is one write to an index.
//
// A document holds MessagePack values as Go values: a map as map[string]any, a list as []any, a whole
// number as int64 (uint64 above math.MaxInt64), any other number as float64, a vector as []float32, a
// timestamp as time.Time, and any other extension as Extension.
type Change struct {
	// SeqNo is the sequence number of the log entry within its partition.
	SeqNo uint64
	// Type says what the write did to the document.
	Type ChangeType
	// DocumentID is the ID of the document that the write touched.
	DocumentID string
	// Document is the document after the write, with every field and every computed vector, and nil
	// after a removal.
	Document narsil.AnyDocument
	// PreviousDocument is the document before the write, set only for an update or a removal while the
	// index has previousDocument on.
	PreviousDocument narsil.AnyDocument
}

// Event is one message of the change feed: a *Subscribed, a *Batch, or a *Resync.
type Event interface {
	changeFeedEvent()
}

// Subscribed is the first event, which gives the positions that the changes follow.
type Subscribed struct {
	// Epoch is the index's epoch. Save it with the positions.
	Epoch string
	// PartitionCount is the number of partitions, each of which has a position.
	PartitionCount uint32
	// Positions are the positions that the changes follow, one for each partition.
	Positions []Position
	// Heads are the partitions' heads when the subscription started.
	Heads []Position
	// BytesBehind is the length in bytes of the history and log between the positions and the heads.
	BytesBehind uint64
	// WindowBytes is how many bytes of changes the server sends before it waits for an acknowledgement.
	WindowBytes uint64
	// PreviousDocument is true when a change can hold the document before the write.
	PreviousDocument bool
}

// Batch holds changes from one partition. Apply the changes, save ScannedSeqNo as the partition's
// position, then acknowledge it with Subscription.Ack.
type Batch struct {
	// PartitionID is the partition that the changes come from.
	PartitionID uint32
	// Changes are in seqNo order, and the list can be empty under a filter.
	Changes []Change
	// ScannedSeqNo is the highest seqNo of the partition that the server examined, which is the next
	// position to save.
	ScannedSeqNo uint64
}

// Resync is the last event when the positions no longer lead to the index's changes. Export the index,
// replace your copy with the export's documents, and follow again from the epoch and the positions in
// the export's header.
type Resync struct {
	// Reason is "epoch" when the index has a new epoch, "history" when the history no longer holds the
	// entries above a position, and "ahead" when a position lies above every entry of its partition.
	Reason string
}

func (*Subscribed) changeFeedEvent() {}
func (*Batch) changeFeedEvent()      {}
func (*Resync) changeFeedEvent()     {}
