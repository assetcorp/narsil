use narsil::Value;

use super::super::PrimaryWrites;
use super::super::log::ReplicationLog;
use crate::allocator::Assignment;
use crate::error::{ClusterError, ClusterResult, codes};

fn led_here(assignment: Option<&Assignment>, node_id: &str) -> bool {
    assignment.is_some_and(|assignment| assignment.is_primary(node_id))
}

impl PrimaryWrites {
    pub(super) async fn reshard_leading_assignment(
        &self,
        index_name: &str,
        partition_id: u32,
    ) -> ClusterResult<Assignment> {
        let assigned = |table: Option<crate::allocator::Table>| {
            table.and_then(|table| table.assignments.get(f64::from(partition_id)).cloned())
        };
        let mut assignment = assigned(self.view.read(index_name).await?);
        if !led_here(assignment.as_ref(), &self.node_id) {
            assignment = assigned(self.view.refresh(index_name).await?);
        }
        match assignment {
            Some(assignment) if assignment.is_primary(&self.node_id) => Ok(assignment),
            other => {
                let primary = other
                    .as_ref()
                    .and_then(|assignment| assignment.primary.as_deref())
                    .map_or(Value::Null, Value::from);
                Err(ClusterError::new(
                    codes::PARTITION_NOT_PRIMARY,
                    format!(
                        "Node '{}' does not lead partition {partition_id} of index '{index_name}'",
                        self.node_id
                    ),
                )
                .with_detail("indexName", Value::from(index_name))
                .with_detail("partitionId", Value::from(partition_id))
                .with_detail("primaryNodeId", primary)
                .with_detail("localNodeId", Value::from(self.node_id.as_str())))
            }
        }
    }

    pub(super) fn forwardable_end_of(
        &self,
        index_name: &str,
        partition_id: u32,
        primary_term: u64,
    ) -> u64 {
        let partition = self.partitions.of(index_name, partition_id);
        let log = crate::controller::lock(&partition.log);
        forwardable_end(&log, primary_term)
    }
}

pub(super) fn forwardable_end(log: &ReplicationLog, primary_term: u64) -> u64 {
    let mut end = log.commit_point();
    loop {
        match log.entry_at(end + 1) {
            Some(next) if next.primary_term < primary_term => end = next.seq_no,
            _ => return end,
        }
    }
}
