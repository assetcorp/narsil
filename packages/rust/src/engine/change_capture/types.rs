use crate::filters::Filter;
use crate::value::Map;

/// A subscriber's place in one partition: the highest sequence number whose changes it has applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ChangePosition {
    /// The partition that the position belongs to.
    pub partition_id: u32,
    /// The highest sequence number of the partition that the subscriber has applied, or 0 before any.
    pub seq_no: u64,
}

/// What a change did to its document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChangeType {
    /// The write stored the document, from an entry that records no previous document, so it can be an insert or
    /// an update.
    Put,
    /// The write stored a document under an ID that the partition held no document under.
    Insert,
    /// The write replaced the document that the partition held under the ID.
    Update,
    /// The write removed the document, or, under a filter, the document stopped matching it.
    Remove,
}

impl ChangeType {
    /// Returns the type as the specification spells it, such as `insert`.
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeType::Put => "put",
            ChangeType::Insert => "insert",
            ChangeType::Update => "update",
            ChangeType::Remove => "remove",
        }
    }
}

/// One insert, update, or removal of a document, which the engine derives from one log entry.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    /// The sequence number of the log entry within its partition.
    pub seq_no: u64,
    /// What the change did to its document.
    pub change_type: ChangeType,
    /// The ID of the document.
    pub document_id: String,
    /// The document after the write, with every field and every computed vector, or `None` for a removal.
    pub document: Option<Map>,
    /// The document before the write, where the index records it and the change carries it.
    pub previous_document: Option<Map>,
}

/// What [`Narsil::changes`](crate::Narsil::changes) takes: where to start, and which documents to follow.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChangesRequest {
    /// The epoch that the positions belong to. Give it together with `positions`, or leave both out to start at
    /// the heads.
    pub epoch: Option<String>,
    /// One position for each partition of the index, from a document export's header or from the
    /// `scanned_seq_no` of the last group of changes that the subscriber applied.
    pub positions: Option<Vec<ChangePosition>>,
    /// A filter in the form of a query's filter, which follows only the documents that match it before or after
    /// each write. It needs an index that records previous documents.
    pub filter: Option<Filter>,
}

/// The first event of a change feed: the epoch, the partition count, where the feed starts, and the heads.
#[derive(Debug, Clone, PartialEq)]
pub struct ChangesSubscribed {
    /// The index epoch, as 32 lowercase hexadecimal digits.
    pub epoch: String,
    /// The number of partitions of the index.
    pub partition_count: u32,
    /// The position that the feed starts from in each partition.
    pub positions: Vec<ChangePosition>,
    /// The highest durable sequence number of each partition when the feed started.
    pub heads: Vec<ChangePosition>,
    /// The length in bytes of the history and log between the positions and the heads.
    pub bytes_behind: u64,
    /// Whether the index records the document before each write, so that a change can carry it.
    pub previous_document: bool,
}

/// The changes of one partition that one read of its log found, with the position that covers them.
#[derive(Debug, Clone, PartialEq)]
pub struct ChangeGroup {
    /// The partition that the changes belong to.
    pub partition_id: u32,
    /// The changes in sequence order. Under a filter the list can be empty, while the position still rises.
    pub changes: Vec<Change>,
    /// The highest sequence number that the read examined, which the subscriber saves as its position in the
    /// partition once it has applied the changes.
    pub scanned_seq_no: u64,
}

/// Why a change feed asks its subscriber to load a fresh document export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ResyncReason {
    /// The index has another epoch than the positions belong to, after a clear, a restore, a partition count
    /// change, or the switch of an analysis change.
    Epoch,
    /// The history no longer holds the entries above a position.
    History,
    /// A position lies above every entry that the partition holds.
    Ahead,
}

impl ResyncReason {
    /// Returns the reason as the specification spells it, such as `history`.
    pub fn as_str(self) -> &'static str {
        match self {
            ResyncReason::Epoch => "epoch",
            ResyncReason::History => "history",
            ResyncReason::Ahead => "ahead",
        }
    }
}

/// One event of a change feed.
#[derive(Debug, Clone, PartialEq)]
pub enum ChangesEvent {
    /// The feed's first event.
    Subscribed(ChangesSubscribed),
    /// The changes that one read of a partition found.
    Changes(ChangeGroup),
    /// The subscriber has to load a fresh document export and subscribe again; the feed ends after this event.
    Resync(ResyncReason),
}
