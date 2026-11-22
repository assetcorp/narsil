mod adopt;
mod append;
pub(crate) mod copy_state;
mod logged;
mod primary;
mod primary_apply;
mod reads;
mod replace;
mod types;

use super::index::IndexState;
use super::{EngineInner, Narsil};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::Value;
use copy_state::ReplicatedCopy;

pub use types::{
    AppliedRun, CopyPosition, EntryOperation, HeldTerm, PrimaryLimits, PrimaryRefusal, PrimaryRun,
    PrimaryWrite, PrimaryWritten, PriorDocument, ReplicatedEntry, WriteRecord,
};

/// The calls that a cluster node makes on its copies of partitions, which keep the sequence numbers and the terms
/// that each partition's primary assigned. Every call blocks, so an async caller runs it off its executor.
///
/// The caller orders the calls for one partition and owns the replication rules. The engine keeps each copy's
/// documents, log, write records, and term history in step.
pub struct PartitionCopies<'a> {
    engine: &'a EngineInner,
}

impl<'a> PartitionCopies<'a> {
    /// Returns the calls on the copies that `engine` holds.
    pub fn new(engine: &'a Narsil) -> PartitionCopies<'a> {
        PartitionCopies {
            engine: &engine.inner,
        }
    }
}

fn copy_of(index: &IndexState) -> Result<&ReplicatedCopy> {
    index.replicated_copy().ok_or_else(|| {
        NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!(
                "Index \"{}\" is not a copy of a cluster's index",
                index.name
            ),
        )
        .with_details([("indexName", Value::from(index.name.as_str()))])
    })
}
