use std::sync::Arc;

use narsil::Value;

use super::PrimaryWrites;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::payload::entry::WireEntry;
use crate::payload::replica::EntryRun;
use crate::payload::sync::SyncBatch;

fn out_of_scope(index_name: &str, partition_id: u32, wire: &WireEntry) -> ClusterError {
    ClusterError::new(
        codes::REPLICATION_ENTRY_INVALID,
        "replication entry scope does not match bootstrap target",
    )
    .with_detail("expectedIndexName", Value::from(index_name))
    .with_detail("expectedPartitionId", Value::from(partition_id))
    .with_detail("entryIndexName", Value::from(wire.index_name.as_str()))
    .with_detail("entryPartitionId", Value::from(wire.partition_id))
}

fn out_of_order(index_name: &str, partition_id: u32, seq_no: u64, expected: u64) -> ClusterError {
    ClusterError::new(
        codes::REPLICATION_ENTRY_INVALID,
        format!("Out-of-order sync entry {seq_no}; expected {expected}"),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail("partitionId", Value::from(partition_id))
    .with_detail("seqNo", Value::from(seq_no))
    .with_detail("expectedSeqNo", Value::from(expected))
}

impl PrimaryWrites {
    pub(crate) async fn apply_sync_batches(
        self: &Arc<Self>,
        index_name: &str,
        partition_id: u32,
        batches: Vec<SyncBatch>,
        first_seq_no: u64,
    ) -> ClusterResult<()> {
        let partition = self.partitions.of(index_name, partition_id);
        let mut expected = first_seq_no;
        for batch in batches {
            let mut entries = Vec::with_capacity(batch.entries.len());
            let mut refused = None;
            for wire in batch.entries {
                if wire.index_name != index_name || wire.partition_id != partition_id {
                    refused = Some(out_of_scope(index_name, partition_id, &wire));
                    break;
                }
                if wire.entry.seq_no != expected {
                    refused = Some(out_of_order(
                        index_name,
                        partition_id,
                        wire.entry.seq_no,
                        expected,
                    ));
                    break;
                }
                expected += 1;
                entries.push(wire);
            }
            let run = EntryRun {
                entries,
                index_uuid: None,
                previous_primary_term: None,
            };
            let turn = partition.turn().await;
            let applied = self.apply_in_log_order(&partition, run).await;
            drop(turn);
            applied?;
            if let Some(error) = refused {
                return Err(error);
            }
        }
        Ok(())
    }
}
