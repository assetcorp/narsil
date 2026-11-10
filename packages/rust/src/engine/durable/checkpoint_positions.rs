use std::collections::BTreeMap;

use super::backing::CheckpointTarget;
use crate::durability::constants::SINGLE_NODE_PRIMARY_TERM;
use crate::error::Result;
use crate::format::manifest::PartitionCheckpoint;

/// Returns the log position that a checkpoint covers in each of `partition_count` partitions: the highest record
/// that the log holds, or that the index applied where no log keeps records, and never less than the previous
/// checkpoint covered.
pub(super) fn partition_checkpoints(
    writer: &CheckpointTarget<'_>,
    applied: &BTreeMap<u32, u64>,
    partition_count: usize,
) -> Result<Vec<PartitionCheckpoint>> {
    let logged = writer.highest_logged()?;
    let prior = writer.prior();
    let mut checkpoint = Vec::with_capacity(partition_count);
    for partition_id in 0..partition_count as u32 {
        let earlier = prior.and_then(|manifest| {
            manifest
                .checkpoint
                .iter()
                .find(|entry| entry.partition_id == partition_id)
        });
        let reached = match &logged {
            Some(logged) => logged
                .iter()
                .find(|(id, _)| *id == partition_id)
                .map_or(0, |(_, seq_no)| *seq_no),
            None => applied.get(&partition_id).copied().unwrap_or(0),
        };
        let last_seq_no = reached.max(earlier.map_or(0, |entry| entry.last_seq_no));
        let primary_term = earlier
            .map_or(SINGLE_NODE_PRIMARY_TERM, |entry| entry.primary_term)
            .max(SINGLE_NODE_PRIMARY_TERM);
        checkpoint.push(PartitionCheckpoint {
            partition_id,
            last_seq_no,
            primary_term,
            term_history: earlier.and_then(|entry| entry.term_history.clone()),
        });
    }
    Ok(checkpoint)
}
