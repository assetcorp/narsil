use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use narsil::replication::CopyPosition;

use super::{ReplicaSync, sync_error, with_cause};
use crate::constants::SYNCED_POSITION_REPORT_TIMEOUT_MS;
use crate::controller::lock;
use crate::data::blocking::off_executor;
use crate::data::watcher::WatcherContext;
use crate::data::watcher::state::PartitionKey;
use crate::data::watcher::sync_frames::SyncFrames;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types};
use crate::node::generate_node_id;
use crate::payload::sync::{SyncRequest, encode_sync_request};
use crate::transport::ChunkHandler;

struct Answer {
    frames: SyncFrames,
    streamed: Option<ClusterResult<()>>,
}

fn reported_term(position: CopyPosition) -> u64 {
    if position.seq_no == 0 {
        0
    } else {
        position.primary_term
    }
}

impl WatcherContext {
    async fn local_position(&self, key: &PartitionKey) -> ClusterResult<CopyPosition> {
        let (copies, name, partition_id) = (Arc::clone(&self.copies), key.0.clone(), key.1);
        let read = off_executor(move || {
            if !copies.holds_index(&name) {
                return Ok(CopyPosition {
                    seq_no: 0,
                    primary_term: 0,
                });
            }
            copies.position(&name, partition_id)
        })
        .await?;
        read.map_err(|error| {
            let failure = sync_error(
                codes::SNAPSHOT_SYNC_RESTORE_FAILED,
                key,
                format!(
                    "reading the position of the local copy failed: {}",
                    error.message()
                ),
            );
            with_cause(failure, &error)
        })
    }

    fn sync_request(
        &self,
        sync: &ReplicaSync<'_>,
        position: CopyPosition,
        sync_session: Option<String>,
    ) -> ClusterResult<TransportMessage> {
        let request = SyncRequest {
            index_name: sync.key.0.clone(),
            partition_id: sync.key.1,
            last_seq_no: position.seq_no,
            last_primary_term: reported_term(position),
            index_uuid: sync.routed_uuid.clone(),
            sync_session,
        };
        Ok(TransportMessage::new(
            message_types::REPLICATION_SYNC_REQUEST,
            self.node_id.as_str(),
            generate_node_id()?,
            encode_sync_request(&request),
        ))
    }

    async fn stream_answer(
        &self,
        target: &str,
        message: TransportMessage,
        budget: Duration,
    ) -> Answer {
        let frames = Arc::new(Mutex::new(SyncFrames::default()));
        let held = Arc::clone(&frames);
        let handler: ChunkHandler = Box::new(move |chunk: Bytes| {
            if lock(&held).take(&chunk) {
                return Ok(());
            }
            Err(ClusterError::new(
                codes::SNAPSHOT_SYNC_FRAME_INVALID,
                "the replica stopped reading the sync answer",
            ))
        });
        let streamed =
            tokio::time::timeout(budget, self.transport.stream(target, message, handler))
                .await
                .ok();
        let frames = std::mem::take(&mut *lock(&frames));
        Answer { frames, streamed }
    }

    pub(super) async fn sync_from(
        self: &Arc<Self>,
        sync: &ReplicaSync<'_>,
        target: &str,
    ) -> ClusterResult<Option<String>> {
        let key = sync.key;
        let position = self.local_position(key).await?;
        let remaining = sync.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(sync_error(
                codes::SNAPSHOT_SYNC_TIMEOUT,
                key,
                "deadline expired before live sync stream".to_string(),
            ));
        }
        let message = self.sync_request(sync, position, None)?;
        let Answer { frames, streamed } = self.stream_answer(target, message, remaining).await;
        if let Some(error) = frames.error {
            return Err(error);
        }
        if frames.saw_snapshot {
            return Err(sync_error(
                codes::SNAPSHOT_SYNC_RESTORE_FAILED,
                key,
                format!(
                    "the primary answered with a snapshot of partition {} of index '{}', which this node cannot restore, so its copy is left as it was",
                    key.1, key.0
                ),
            ));
        }
        match streamed {
            None => {
                return Err(sync_error(
                    codes::SNAPSHOT_SYNC_TIMEOUT,
                    key,
                    "bootstrap sync exceeded deadline during live-sync".to_string(),
                ));
            }
            Some(Err(error)) => {
                let failure = sync_error(
                    codes::SNAPSHOT_SYNC_TRANSPORT_FAILED,
                    key,
                    format!("live sync transport failed: {}", error.message()),
                );
                return Err(with_cause(failure, &error));
            }
            Some(Ok(())) => {}
        }
        frames.check_termination()?;
        if frames.batches.is_empty() {
            return Err(sync_error(
                codes::SNAPSHOT_SYNC_CHUNK_MISSING,
                key,
                "live sync stream ended without sync frames".to_string(),
            ));
        }
        self.ensure_replica_copy(sync).await?;
        self.writes
            .apply_sync_batches(&key.0, key.1, frames.batches, position.seq_no + 1)
            .await?;
        Ok(frames.sync_session)
    }

    pub(super) async fn report_synced_position(
        &self,
        sync: &ReplicaSync<'_>,
        target: &str,
        sync_session: Option<String>,
    ) -> ClusterResult<()> {
        let key = sync.key;
        let position = self.local_position(key).await?;
        let remaining = sync.deadline.saturating_duration_since(Instant::now());
        let budget = remaining.min(Duration::from_millis(SYNCED_POSITION_REPORT_TIMEOUT_MS));
        if budget.is_zero() {
            return Err(sync_error(
                codes::SNAPSHOT_SYNC_TIMEOUT,
                key,
                "bootstrap sync exceeded deadline before reporting the synced position".to_string(),
            ));
        }
        let message = self.sync_request(sync, position, sync_session)?;
        let Answer { frames, streamed } = self.stream_answer(target, message, budget).await;
        if let Some(error) = frames.error {
            return Err(error);
        }
        if frames.saw_snapshot {
            return Err(sync_error(
                codes::SNAPSHOT_SYNC_TRANSPORT_FAILED,
                key,
                "the primary no longer retains the synced position, so the copy syncs again"
                    .to_string(),
            ));
        }
        match streamed {
            Some(Ok(())) => Ok(()),
            None => Err(sync_error(
                codes::SNAPSHOT_SYNC_TRANSPORT_FAILED,
                key,
                format!(
                    "reporting the synced position timed out after {}ms",
                    budget.as_millis()
                ),
            )),
            Some(Err(error)) => {
                let failure = sync_error(
                    codes::SNAPSHOT_SYNC_TRANSPORT_FAILED,
                    key,
                    format!("reporting the synced position failed: {}", error.message()),
                );
                Err(with_cause(failure, &error))
            }
        }
    }
}
