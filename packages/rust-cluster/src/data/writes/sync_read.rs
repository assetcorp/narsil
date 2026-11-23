use std::sync::Arc;

use narsil::{ChangePosition, Map, SyncCursor, SyncEntry, SyncRead, Value};

use super::PrimaryWrites;
use crate::allocator::{Assignment, Table};
use crate::constants::MAX_SAFE_INTEGER;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types};
use crate::node::decode_request_payload;
use crate::wire::{write_array_header, write_map_header, write_str, write_uint};

const UINT32_MAX: u64 = 0xffff_ffff;
const INITIALISING: &str = "INITIALISING";

pub(crate) struct SyncReadRequest {
    pub(crate) index_name: String,
    pub(crate) index_uuid: String,
    pub(crate) partition_id: u32,
    pub(crate) after_seq_no: u64,
    pub(crate) max_bytes: u32,
}

pub(crate) struct SyncReadReply {
    pub(crate) entries: Vec<SyncEntry>,
    pub(crate) head: u64,
    pub(crate) highest_seq_no: u64,
    pub(crate) oldest_seq_no: u64,
    pub(crate) bytes_behind: u64,
}

fn whole_number(fields: &Map, key: &str) -> Option<u64> {
    match fields.get(key) {
        Some(Value::Number(number))
            if number.is_finite()
                && number.fract() == 0.0
                && *number >= 0.0
                && *number <= MAX_SAFE_INTEGER as f64 =>
        {
            Some(*number as u64)
        }
        _ => None,
    }
}

fn filled_text(fields: &Map, key: &str) -> Option<String> {
    match fields.get(key) {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

fn validate_sync_read_request(decoded: &Value) -> Option<SyncReadRequest> {
    let Value::Object(fields) = decoded else {
        return None;
    };
    let partition_id = whole_number(fields, "partitionId").filter(|id| *id <= UINT32_MAX)?;
    let max_bytes =
        whole_number(fields, "maxBytes").filter(|bytes| (1..=UINT32_MAX).contains(bytes))?;
    Some(SyncReadRequest {
        index_name: filled_text(fields, "indexName")?,
        index_uuid: filled_text(fields, "indexUuid")?,
        partition_id: u32::try_from(partition_id).ok()?,
        after_seq_no: whole_number(fields, "afterSeqNo")?,
        max_bytes: u32::try_from(max_bytes).ok()?,
    })
}

fn encode_sync_read_reply(reply: &SyncReadReply) -> Vec<u8> {
    let entry_bytes: usize = reply.entries.iter().map(|entry| entry.payload.len()).sum();
    let mut out = Vec::with_capacity(entry_bytes + 96);
    write_map_header(&mut out, 5);
    write_str(&mut out, "entries");
    write_array_header(&mut out, reply.entries.len());
    for entry in &reply.entries {
        out.extend_from_slice(&entry.payload);
    }
    write_str(&mut out, "head");
    write_uint(&mut out, reply.head);
    write_str(&mut out, "highestSeqNo");
    write_uint(&mut out, reply.highest_seq_no);
    write_str(&mut out, "oldestSeqNo");
    write_uint(&mut out, reply.oldest_seq_no);
    write_str(&mut out, "bytesBehind");
    write_uint(&mut out, reply.bytes_behind);
    out
}

fn assignment_of(table: Option<&Table>, partition_id: u32) -> Option<&Assignment> {
    table?.assignments.get(f64::from(partition_id))
}

fn initialising(index_name: &str, partition_id: u32, node_id: &str) -> ClusterError {
    ClusterError::new(
        codes::QUERY_NO_ACTIVE_REPLICA,
        format!(
            "Node '{node_id}' serves no read, because partition {partition_id} of index '{index_name}' is INITIALISING"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail("partitionId", Value::from(partition_id))
    .with_detail("nodeId", Value::from(node_id))
}

impl PrimaryWrites {
    async fn lead_for_sync_read(&self, index_name: &str, partition_id: u32) -> ClusterResult<()> {
        let mut table = self.view.read(index_name).await?;
        if assignment_of(table.as_ref(), partition_id)
            .is_none_or(|held| !held.is_primary(&self.node_id))
        {
            table = self.view.refresh(index_name).await?;
        }
        let assignment = assignment_of(table.as_ref(), partition_id);
        if let Some(assignment) = assignment.filter(|held| held.is_primary(&self.node_id)) {
            if assignment.state != INITIALISING {
                return Ok(());
            }
            let live = self.view.refresh(index_name).await.ok().flatten();
            let confirmed = assignment_of(live.as_ref(), partition_id)
                .is_none_or(|held| held.state == INITIALISING);
            if confirmed {
                return Err(initialising(index_name, partition_id, &self.node_id));
            }
            return Ok(());
        }
        let primary = assignment
            .and_then(|held| held.primary.clone())
            .map_or(Value::Null, Value::String);
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

    pub(crate) async fn answer_sync_read_request(
        &self,
        request: SyncReadRequest,
    ) -> ClusterResult<SyncReadReply> {
        let SyncReadRequest {
            index_name,
            index_uuid,
            partition_id,
            after_seq_no,
            max_bytes,
        } = request;
        self.lead_for_sync_read(&index_name, partition_id).await?;
        let name = index_name.clone();
        let held_uuid = self
            .on_copies(move |copies| copies.local_uuid(&name))
            .await?;
        if held_uuid.as_deref() != Some(index_uuid.as_str()) {
            return Err(ClusterError::new(
                codes::INDEX_NOT_FOUND,
                format!(
                    "Node '{}' holds no copy of index '{index_name}'",
                    self.node_id
                ),
            )
            .with_detail("indexName", Value::from(index_name.as_str()))
            .with_detail("indexUuid", Value::from(index_uuid.as_str())));
        }
        let (commit_point, local_log_end) = {
            let partition = self.partitions.of(&index_name, partition_id);
            let log = crate::controller::lock(&partition.log);
            (log.commit_point(), log.newest_seq_no().unwrap_or(0))
        };
        self.on_copies(move |copies| {
            let engine = &copies.engine;
            let bounds = engine.sync_bounds(&index_name, partition_id)?;
            let head = commit_point.min(bounds.head);
            let highest_seq_no = bounds.head.max(bounds.highest_seq_no).max(local_log_end);
            if after_seq_no >= head {
                return Ok(SyncReadReply {
                    entries: Vec::new(),
                    head,
                    highest_seq_no,
                    oldest_seq_no: bounds.oldest_seq_no,
                    bytes_behind: 0,
                });
            }
            let mut cursor = SyncCursor::after(partition_id, after_seq_no);
            let read =
                engine.read_sync_entries(&index_name, &mut cursor, head, max_bytes as usize)?;
            let bytes_behind = engine.sync_bytes_behind(
                &index_name,
                &[ChangePosition {
                    partition_id,
                    seq_no: after_seq_no,
                }],
            )?;
            let (entries, oldest_seq_no) = match read {
                SyncRead::Entries(entries) => (entries, bounds.oldest_seq_no),
                SyncRead::HistoryGone => (
                    Vec::new(),
                    bounds.oldest_seq_no.max(after_seq_no.saturating_add(2)),
                ),
            };
            Ok(SyncReadReply {
                entries,
                head,
                highest_seq_no,
                oldest_seq_no,
                bytes_behind,
            })
        })
        .await
    }

    pub(crate) async fn answer_sync_read(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> ClusterResult<TransportMessage> {
        let decoded = decode_request_payload(&message.payload, &message.message_type)?;
        let Some(request) = validate_sync_read_request(&decoded) else {
            return Err(ClusterError::new(
                codes::CONFIG_INVALID,
                "A sync.read request is malformed",
            )
            .with_detail("sourceNodeId", Value::from(message.source_id.as_str())));
        };
        let reply = self.answer_sync_read_request(request).await?;
        Ok(TransportMessage::new(
            message_types::SYNC_READ,
            self.node_id.as_str(),
            message.request_id.as_str(),
            encode_sync_read_reply(&reply),
        ))
    }
}
