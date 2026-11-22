use std::sync::Arc;

use narsil::replication::ReplicatedEntry;

use super::feed::run_bytes;
use super::state::Feed;
use crate::controller::lock;
use crate::data::writes::PrimaryWrites;
use crate::data::writes::partition::Partition;
use crate::data::writes::scope::Scope;
use crate::error::ClusterResult;

impl PrimaryWrites {
    pub(super) async fn retained_span(
        &self,
        partition: &Partition,
        scope: &Scope,
    ) -> ClusterResult<(u64, Option<u64>)> {
        let (oldest, newest) = {
            let log = lock(&partition.log);
            (log.oldest_seq_no(), log.newest_seq_no())
        };
        if let Some(newest) = newest {
            return Ok((newest, oldest));
        }
        let (name, partition_id) = (scope.index_name.clone(), scope.partition_id);
        let position = self
            .on_copies(move |copies| copies.position(&name, partition_id))
            .await?;
        Ok((position.seq_no, None))
    }

    pub(super) fn cursor_state(
        partition: &Partition,
        replica_node_id: &str,
    ) -> Option<(u64, bool, u64)> {
        lock(&partition.catch_up)
            .cursors
            .get(replica_node_id)
            .map(|cursor| (cursor.applied_seq_no, cursor.confirmed, cursor.sync_epoch))
    }

    pub(super) fn next_batch(
        partition: &Partition,
        index_name: &str,
        from_seq_no: u64,
    ) -> (Vec<ReplicatedEntry>, bool) {
        let log = lock(&partition.log);
        let Some(log_end) = log.newest_seq_no() else {
            return (Vec::new(), false);
        };
        let batch = log.batch_from(index_name, from_seq_no, log_end);
        let reaches_log_end = batch.last().is_some_and(|last| last.seq_no == log_end);
        (batch, reaches_log_end)
    }

    pub(super) async fn send_batch(
        self: &Arc<Self>,
        partition: &Partition,
        scope: &Scope,
        batch: &[ReplicatedEntry],
        replica_node_id: &str,
        feed: &Feed,
    ) -> bool {
        let Some(last) = batch.last() else {
            return false;
        };
        let Some(_reserved) = self.reserve(run_bytes(&scope.index_name, batch)) else {
            return false;
        };
        let Some((_, _, sending_epoch)) = Self::cursor_state(partition, replica_node_id) else {
            return false;
        };
        let targets = [replica_node_id.to_string()];
        let sent = feed
            .until_cancelled(self.send_entries(scope, batch, &targets), Ok(Vec::new()))
            .await;
        let acknowledged =
            sent.is_ok_and(|sent| sent.iter().any(|(_, acknowledged)| *acknowledged));
        if !acknowledged || feed.is_cancelled() {
            return false;
        }
        let mut catch_up = lock(&partition.catch_up);
        let Some(cursor) = catch_up.cursors.get_mut(replica_node_id) else {
            return false;
        };
        if cursor.sync_epoch != sending_epoch {
            return false;
        }
        cursor.applied_seq_no = cursor.applied_seq_no.max(last.seq_no);
        cursor.confirmed = true;
        true
    }

    pub(super) async fn close_gap_in_queue(
        self: &Arc<Self>,
        partition: &Arc<Partition>,
        scope: &Scope,
        replica_node_id: &str,
        feed: &Arc<Feed>,
    ) {
        let queued = async {
            let _turn = partition.turn().await;
            loop {
                let (applied, _, _) = Self::cursor_state(partition, replica_node_id)?;
                let Ok((log_end, _)) = self.retained_span(partition, scope).await else {
                    return None;
                };
                if applied >= log_end {
                    break;
                }
                let (batch, _) = Self::next_batch(partition, &scope.index_name, applied + 1);
                if self.is_stopping() || feed.is_cancelled() || batch.is_empty() {
                    return None;
                }
                if !self
                    .send_batch(partition, scope, &batch, replica_node_id, feed)
                    .await
                {
                    return None;
                }
            }
            if feed.is_cancelled() {
                return None;
            }
            self.claim_admission(partition, replica_node_id)
        };
        let Some(claim) = feed.until_cancelled(queued, None).await else {
            return;
        };
        let request = self.spawn_admission(partition, scope, replica_node_id, claim);
        feed.until_cancelled(request, Ok(())).await.ok();
    }
}
