use crate::error::NarsilError;
use crate::format::wal::{EntryPlace, LogEntry, Operation};
use crate::value::Map;

/// What a replicated entry does to its document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryOperation {
    /// Stores the entry's whole document in place of any copy that the partition holds.
    Index,
    /// Removes the entry's document.
    Delete,
}

impl EntryOperation {
    pub(crate) fn logged(self) -> Operation {
        match self {
            EntryOperation::Index => Operation::Index,
            EntryOperation::Delete => Operation::Delete,
        }
    }
}

/// One entry of a partition's replication log, which each copy writes to its write-ahead log under the sequence
/// number and the term that the primary assigned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplicatedEntry {
    /// The number that the primary assigned within the partition.
    pub seq_no: u64,
    /// The term under which the primary appended the entry.
    pub primary_term: u64,
    /// What the entry does.
    pub operation: EntryOperation,
    /// The ID of the entry's document.
    pub document_id: String,
    /// The whole document as MessagePack for an index entry, or `None` for a delete.
    pub document: Option<Vec<u8>>,
    /// The document before the write: `None` leaves the key out of the entry, and `Some(None)` writes nil.
    pub previous_document: Option<Option<Vec<u8>>>,
}

impl ReplicatedEntry {
    /// Returns the checksum of the entry's content fields in `partition` of `index`.
    pub fn checksum(&self, index: &str, partition: u32) -> u32 {
        let place = EntryPlace {
            seq_no: self.seq_no,
            primary_term: self.primary_term,
            partition_id: partition,
            index_name: index,
        };
        LogEntry::new(
            place,
            self.operation.logged(),
            &self.document_id,
            self.document.clone(),
            self.previous_document.clone(),
        )
        .checksum as u32
    }
}

/// The highest entry that a copy of a partition holds, which is zero in both fields for an empty copy.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CopyPosition {
    /// The entry's sequence number.
    pub seq_no: u64,
    /// The term of that entry.
    pub primary_term: u64,
}

/// The entry that last wrote a document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteRecord {
    /// The entry's sequence number.
    pub seq_no: u64,
    /// The term of that entry.
    pub primary_term: u64,
}

/// What a copy's term history gives for one sequence number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeldTerm {
    /// The number is above the highest entry that the copy holds.
    Absent,
    /// The history no longer covers the number.
    Uncovered,
    /// The copy holds the number under this term.
    Held(u64),
}

/// One write that a primary applies to its copy.
#[derive(Debug, Clone, PartialEq)]
pub enum PrimaryWrite {
    /// Stores a document that the partition must not hold yet.
    Insert {
        /// The ID that the document is stored under.
        document_id: String,
        /// The whole document.
        document: Map,
    },
    /// Replaces a document that the partition holds.
    Update {
        /// The ID that the document is stored under.
        document_id: String,
        /// The whole new document.
        document: Map,
    },
    /// Removes a document that the partition holds.
    Remove {
        /// The ID that the document is stored under.
        document_id: String,
    },
}

impl PrimaryWrite {
    pub(crate) fn document_id(&self) -> &str {
        match self {
            PrimaryWrite::Insert { document_id, .. }
            | PrimaryWrite::Update { document_id, .. }
            | PrimaryWrite::Remove { document_id } => document_id,
        }
    }
}

/// What a primary's entries must keep to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrimaryLimits {
    /// Whether each entry carries the document that it replaces or removes.
    pub records_previous_documents: bool,
    /// The most bytes that one entry may take in the replication log.
    pub max_entry_bytes: u64,
}

/// The document that a write replaced or removed, which the write's compensation stores again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PriorDocument {
    /// The whole document as MessagePack, vectors included.
    pub document: Vec<u8>,
    /// The entry that had written the document, where the copy holds its record.
    pub record: Option<WriteRecord>,
}

/// One write that the primary applied and numbered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrimaryWritten {
    /// The entry to send to the other copies.
    pub entry: ReplicatedEntry,
    /// What the write replaced, or `None` where the partition held no such document.
    pub prior: Option<PriorDocument>,
}

/// Why a primary refused one write without applying it.
#[derive(Debug, Clone, PartialEq)]
pub enum PrimaryRefusal {
    /// The engine refused the write.
    Refused(NarsilError),
    /// The write's entry exceeds what the replication log can hold.
    EntryTooLarge {
        /// The bytes that the entry takes.
        bytes: u64,
    },
}

impl From<NarsilError> for PrimaryRefusal {
    fn from(error: NarsilError) -> PrimaryRefusal {
        PrimaryRefusal::Refused(error)
    }
}

/// What one call of writes did on the primary's copy.
#[derive(Debug, Clone, PartialEq)]
pub struct PrimaryRun {
    /// One outcome for each write, in the order of the writes.
    pub outcomes: Vec<std::result::Result<PrimaryWritten, PrimaryRefusal>>,
    /// The failure that stops the copy from taking another entry, where the log failed. Every outcome is a refusal
    /// where the copy put the writes back.
    pub failure: Option<NarsilError>,
}

/// What one run of entries did on a copy.
#[derive(Debug, Clone, PartialEq)]
pub struct AppliedRun {
    /// The number of entries from the start of the run that the copy applied, logged, and made durable.
    pub applied: usize,
    /// The failure that stopped the run, where one did.
    pub failure: Option<NarsilError>,
}
