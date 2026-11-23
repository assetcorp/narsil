use std::sync::Arc;

use narsil::{Map, SyncEntry, Value, decode_msgpack, encode_msgpack};

use super::view::DeviceSyncView;
use crate::constants::MAX_SAFE_INTEGER;
use crate::data::writes::{AllocationView, PrimaryWrites, SyncReadReply, SyncReadRequest};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types};
use crate::node::generate_node_id;
use crate::transport::NodeTransport;

pub(crate) struct PrimaryReads {
    pub(crate) node_id: String,
    pub(crate) transport: Arc<dyn NodeTransport>,
    pub(crate) writes: Option<Arc<PrimaryWrites>>,
    pub(crate) routing: Arc<AllocationView>,
    pub(crate) view: Arc<DeviceSyncView>,
}

fn sync_not_enabled(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::SYNC_NOT_ENABLED,
        format!("Index \"{index_name}\" has device sync off"),
    )
    .with_detail("indexName", Value::from(index_name))
}

fn reply_error(
    node_id: &str,
    failure: Option<ClusterError>,
    index_name: &str,
    partition_id: u32,
) -> ClusterError {
    let (code, message) = match &failure {
        Some(failure) if !failure.code().is_empty() => {
            (failure.code().to_string(), failure.message().to_string())
        }
        _ => (
            codes::QUERY_ROUTING_FAILED.to_string(),
            format!(
                "Node '{node_id}' did not answer sync.read for partition {partition_id} of index '{index_name}'"
            ),
        ),
    };
    ClusterError::new(code, message)
        .with_detail("indexName", Value::from(index_name))
        .with_detail("partitionId", Value::from(partition_id))
        .with_detail("targetNodeId", Value::from(node_id))
}

fn sequence_number(fields: &Map, key: &str) -> Option<u64> {
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

fn decode_reply(payload: &[u8], partition_id: u32, after_seq_no: u64) -> Option<SyncReadReply> {
    let Ok(Value::Object(fields)) = decode_msgpack(payload) else {
        return None;
    };
    let Some(Value::Array(listed)) = fields.get("entries") else {
        return None;
    };
    let head = sequence_number(&fields, "head")?;
    let highest_seq_no = sequence_number(&fields, "highestSeqNo")?;
    let oldest_seq_no = sequence_number(&fields, "oldestSeqNo")?;
    let bytes_behind = sequence_number(&fields, "bytesBehind")?;
    let mut entries = Vec::with_capacity(listed.len());
    let mut previous = after_seq_no;
    for entry in listed {
        let Value::Object(entry_fields) = entry else {
            return None;
        };
        let seq_no = sequence_number(entry_fields, "seqNo")?;
        if seq_no <= previous || seq_no > head {
            return None;
        }
        if entry_fields.get("partitionId") != Some(&Value::Number(f64::from(partition_id))) {
            return None;
        }
        let payload = encode_msgpack(entry).ok()?;
        entries.push(SyncEntry { seq_no, payload });
        previous = seq_no;
    }
    Some(SyncReadReply {
        entries,
        head,
        highest_seq_no,
        oldest_seq_no,
        bytes_behind,
    })
}

impl PrimaryReads {
    async fn ask_primary(
        &self,
        primary: &str,
        index_name: &str,
        request: SyncReadRequest,
    ) -> ClusterResult<SyncReadReply> {
        if primary == self.node_id
            && let Some(writes) = &self.writes
        {
            return writes.answer_sync_read_request(request).await;
        }
        let (partition_id, after_seq_no) = (request.partition_id, request.after_seq_no);
        let mut fields = Map::with_capacity(5);
        fields.insert("indexName", Value::String(request.index_name));
        fields.insert("indexUuid", Value::String(request.index_uuid));
        fields.insert("partitionId", Value::from(partition_id));
        fields.insert("afterSeqNo", Value::Number(after_seq_no as f64));
        fields.insert("maxBytes", Value::from(request.max_bytes));
        let payload = encode_msgpack(&Value::Object(fields)).map_err(ClusterError::from)?;
        let message = TransportMessage::new(
            message_types::SYNC_READ,
            self.node_id.as_str(),
            generate_node_id()?,
            payload,
        );
        let mut last_error: Option<ClusterError> = None;
        for target in self.routing.targets(primary) {
            let answer = match self.transport.send(&target, message.clone()).await {
                Ok(answer) => answer,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
            if answer.is_failure() {
                return Err(reply_error(
                    primary,
                    answer.failure(),
                    index_name,
                    partition_id,
                ));
            }
            return decode_reply(&answer.payload, partition_id, after_seq_no)
                .ok_or_else(|| reply_error(primary, None, index_name, partition_id));
        }
        let mut timeout = ClusterError::new(
            codes::QUERY_NODE_TIMEOUT,
            format!(
                "Node '{primary}' did not answer sync.read for partition {partition_id} of index '{index_name}'"
            ),
        )
        .with_detail("indexName", Value::from(index_name))
        .with_detail("partitionId", Value::from(partition_id));
        if let Some(error) = last_error {
            timeout = timeout.with_detail("transportCode", Value::from(error.code()));
        }
        Err(timeout)
    }

    pub(crate) async fn read_from_primary(
        &self,
        index_name: &str,
        partition_id: u32,
        after_seq_no: u64,
        max_bytes: u32,
    ) -> ClusterResult<SyncReadReply> {
        let Some(held) = self.view.held(index_name) else {
            return Err(sync_not_enabled(index_name));
        };
        let layout = held.serving;
        let mut attempt = 0;
        loop {
            let table = self.routing.read(&layout.serving_name).await?;
            let primary = table
                .as_ref()
                .and_then(|table| table.assignments.get(f64::from(partition_id)))
                .and_then(|assignment| assignment.primary.clone());
            let Some(primary) = primary else {
                return Err(ClusterError::new(
                    codes::QUERY_NO_ACTIVE_REPLICA,
                    format!(
                        "Partition {partition_id} of index '{index_name}' has no primary to read the feed from"
                    ),
                )
                .with_detail("indexName", Value::from(index_name))
                .with_detail("partitionId", Value::from(partition_id)));
            };
            let request = SyncReadRequest {
                index_name: layout.serving_name.clone(),
                index_uuid: layout.index_uuid.clone(),
                partition_id,
                after_seq_no,
                max_bytes,
            };
            match self.ask_primary(&primary, index_name, request).await {
                Err(error) if attempt == 0 && error.code() == codes::PARTITION_NOT_PRIMARY => {
                    attempt += 1;
                    self.routing.refresh(&layout.serving_name).await?;
                }
                other => return other,
            }
        }
    }
}
