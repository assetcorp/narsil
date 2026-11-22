use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio::time::Instant;

use super::WriteRouter;
use super::retry::Answered;
use super::write::{ClientWrite, PendingWrite};
use crate::constants::{PARTITION_WRITE_CONCURRENCY, PRIMARY_CHANGE_RETRY_WINDOW_MS};
use crate::data::routed_partition;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::payload::forward::ForwardKind;

fn stopped_before_answering(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::INTERNAL_ERROR,
        format!("A batch write to index '{index_name}' stopped before it answered"),
    )
}

impl WriteRouter {
    pub(crate) async fn write(
        self: &Arc<Self>,
        index_name: &str,
        writes: Vec<ClientWrite>,
        batch: bool,
    ) -> ClusterResult<Vec<Result<(), ClusterError>>> {
        let serving_name: Arc<str> = Arc::from(self.serving_name(index_name).await?);
        let table = self.routable_table(&serving_name).await?;
        let count = writes.len();
        let settles_as_equal = writes
            .first()
            .is_some_and(|write| write.kind == ForwardKind::Insert);
        let partition_count = table.assignments.len();
        let mut groups: BTreeMap<u32, Vec<PendingWrite>> = BTreeMap::new();
        for (position, write) in writes.into_iter().enumerate() {
            let partition_id = routed_partition(&write.document_id, partition_count);
            groups.entry(partition_id).or_default().push(PendingWrite {
                position,
                write: Arc::new(write),
                condition: None,
            });
        }
        let turns = Arc::new(Semaphore::new(PARTITION_WRITE_CONCURRENCY));
        let mut running: JoinSet<Vec<Answered>> = JoinSet::new();
        for (_, group) in groups {
            let router = Arc::clone(self);
            let serving_name = Arc::clone(&serving_name);
            let turns = Arc::clone(&turns);
            running.spawn(async move {
                let Ok(_turn) = turns.acquire_owned().await else {
                    let stopped = stopped_before_answering(&serving_name);
                    return group
                        .iter()
                        .map(|write| (write.position, Err(stopped.clone())))
                        .collect();
                };
                let deadline =
                    Instant::now() + Duration::from_millis(PRIMARY_CHANGE_RETRY_WINDOW_MS);
                router
                    .retry_group(serving_name, group, deadline, settles_as_equal, batch)
                    .await
            });
        }
        let mut answered: Vec<Option<Result<(), ClusterError>>> =
            (0..count).map(|_| None).collect();
        while let Some(joined) = running.join_next().await {
            let Ok(outcomes) = joined else {
                continue;
            };
            for (position, outcome) in outcomes {
                if let Some(slot) = answered.get_mut(position) {
                    *slot = Some(outcome);
                }
            }
        }
        Ok(answered
            .into_iter()
            .map(|outcome| outcome.unwrap_or_else(|| Err(stopped_before_answering(index_name))))
            .collect())
    }
}
