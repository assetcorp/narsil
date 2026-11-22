mod records;
mod steps;

use std::sync::Arc;
use std::time::Duration;

use narsil::{ErrorCode, Value};

pub(super) use self::records::CopyFailures;
use self::steps::{Round, Step};
use super::PrimaryWrites;
use crate::constants::{COPY_FAILURE_ATTEMPTS, COPY_FAILURE_RETRY_DELAY_MS};
use crate::error::{ClusterError, codes};

impl PrimaryWrites {
    pub(super) fn record_copy_failure(self: &Arc<Self>, index_name: &str, partition_id: u32) {
        if let Some(claim) = self.failures.claim(index_name, partition_id) {
            self.spawn_recovery(index_name, partition_id, claim);
        }
    }

    pub(crate) fn fail_missing_copy(self: &Arc<Self>, index_name: &str, partition_id: u32) {
        let Some(started) = self.failures.claim_missing(index_name, partition_id) else {
            return;
        };
        self.report(
            &ClusterError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED.as_str(),
                format!(
                    "Partition {partition_id} of index '{index_name}' has no copy on this node to reload, so the node gives up the lead and leaves the partition out of the partitions it reports holding"
                ),
            )
            .with_detail("indexName", Value::from(index_name))
            .with_detail("partitionId", Value::from(partition_id))
            .with_detail("nodeId", Value::from(self.node_id.as_str())),
        );
        if let Some(claim) = started {
            self.spawn_recovery(index_name, partition_id, claim);
        }
    }

    fn spawn_recovery(self: &Arc<Self>, index_name: &str, partition_id: u32, claim: u64) {
        let writes = Arc::clone(self);
        let index_name = index_name.to_string();
        tokio::spawn(async move {
            let reset = writes.recover(&index_name, partition_id, claim).await;
            writes
                .failures
                .finish(&index_name, partition_id, claim, reset);
        });
    }

    pub(super) async fn held_failure(
        self: &Arc<Self>,
        index_name: &str,
        partition_id: u32,
    ) -> Option<ClusterError> {
        let name = index_name.to_string();
        let held = self
            .on_copies(move |copies| copies.copy_failure(&name, partition_id))
            .await;
        if let Ok(Some(failure)) = held {
            self.record_copy_failure(index_name, partition_id);
            return Some(ClusterError::from(failure));
        }
        self.failures
            .is_failed(index_name, partition_id)
            .then(|| self.failed_copy_refusal(index_name, partition_id))
    }

    pub(super) fn failed_copy_refusal(&self, index_name: &str, partition_id: u32) -> ClusterError {
        ClusterError::new(
            codes::REPLICATION_ENTRY_INVALID,
            format!(
                "Partition {partition_id} of index '{index_name}' holds a failed copy on node '{}', which takes no entries until it syncs again from an empty copy",
                self.node_id
            ),
        )
        .with_detail("indexName", Value::from(index_name))
        .with_detail("partitionId", Value::from(partition_id))
        .with_detail("nodeId", Value::from(self.node_id.as_str()))
    }

    pub(crate) fn copy_unlisted(&self, index_name: &str, partition_id: u32) -> bool {
        self.failures.is_unlisted(index_name, partition_id)
    }

    async fn recover(&self, index_name: &str, partition_id: u32, claim: u64) -> bool {
        let mut round = Round::new(claim);
        let mut last_error = None;
        for attempt in 0..COPY_FAILURE_ATTEMPTS {
            if self.is_stopping() || !self.failures.is_current(index_name, partition_id, claim) {
                return false;
            }
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(COPY_FAILURE_RETRY_DELAY_MS)).await;
            }
            let step = match self.view.read_live(index_name).await {
                Ok(table) => {
                    self.step_for(&mut round, table, index_name, partition_id)
                        .await
                }
                Err(error) => Err(error),
            };
            match step {
                Ok(Step::Reset) => return true,
                Ok(Step::Kept) => return false,
                Ok(Step::Retry) => {}
                Err(error) => last_error = Some(error),
            }
        }
        let cause = last_error.map_or_else(
            || "every attempt found the copy still in service".to_string(),
            |error| error.message().to_string(),
        );
        self.report(
            &ClusterError::new(
                codes::REPLICATION_INSYNC_REMOVAL_FAILED,
                format!(
                    "Partition {partition_id} of index '{index_name}' keeps a failed copy, because the controller never took it out of service: {cause}"
                ),
            )
            .with_detail("indexName", Value::from(index_name))
            .with_detail("partitionId", Value::from(partition_id))
            .with_detail("nodeId", Value::from(self.node_id.as_str()))
            .with_detail("cause", Value::from(cause.as_str())),
        );
        false
    }
}
