use narsil::Value;

use super::entry::{WireEntry, write_entry};
use super::fields::{Field, fields_of};
use super::replica::decode_entry;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::wire::{self, write_array_header, write_bool, write_map_header, write_str, write_uint};

const SYNC_ENTRIES_PAYLOAD: &str = "SyncEntriesPayload";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SyncRequest {
    pub(crate) index_name: String,
    pub(crate) partition_id: u32,
    pub(crate) last_seq_no: u64,
    pub(crate) last_primary_term: u64,
    pub(crate) index_uuid: Option<String>,
    pub(crate) sync_session: Option<String>,
}

pub(crate) struct SyncBatch {
    pub(crate) entries: Vec<WireEntry>,
    pub(crate) is_last: bool,
}

pub(crate) enum SyncFrame {
    Entries {
        entries: Vec<WireEntry>,
        is_last: bool,
        sync_session: Option<String>,
    },
    Snapshot,
}

pub(crate) struct InsyncAdmission<'a> {
    pub(crate) index_name: &'a str,
    pub(crate) partition_id: u32,
    pub(crate) replica_node_id: &'a str,
    pub(crate) primary_term: u64,
    pub(crate) applied_seq_no: u64,
    pub(crate) commit_point: u64,
    pub(crate) in_sync_version: u64,
    pub(crate) replica_started_at: &'a str,
}

fn invalid_request(reason: &str) -> ClusterError {
    ClusterError::new(
        codes::SNAPSHOT_SYNC_REQUEST_INVALID,
        format!("Invalid SyncRequestPayload: {reason}"),
    )
}

fn optional_filled(field: Field<'_>, name: &str) -> ClusterResult<Option<String>> {
    field
        .optional(|value| value.filled_text().map(str::to_string))
        .ok_or_else(|| invalid_request(&format!("\"{name}\" must be a non-empty string or absent")))
}

fn whole(field: Field<'_>, name: &str) -> ClusterResult<u64> {
    field
        .count()
        .ok_or_else(|| invalid_request(&format!("\"{name}\" must be a non-negative integer")))
}

pub(crate) fn decode_sync_request(payload: &[u8]) -> ClusterResult<SyncRequest> {
    if wire::validate(payload).is_err() {
        return Err(invalid_request("the payload is not valid MessagePack"));
    }
    let Some(fields) = fields_of(
        payload,
        [
            "indexName",
            "partitionId",
            "lastSeqNo",
            "lastPrimaryTerm",
            "indexUuid",
            "syncSession",
        ],
    ) else {
        return Err(invalid_request("expected an object"));
    };
    let [
        index_name,
        partition_id,
        last_seq_no,
        last_primary_term,
        uuid,
        session,
    ] = fields;
    let index_name = index_name
        .text()
        .ok_or_else(|| invalid_request("\"indexName\" must be a string"))?;
    let partition_id = u32::try_from(whole(partition_id, "partitionId")?)
        .map_err(|_| invalid_request("\"partitionId\" must be a non-negative integer"))?;
    Ok(SyncRequest {
        index_name: index_name.to_string(),
        partition_id,
        last_seq_no: whole(last_seq_no, "lastSeqNo")?,
        last_primary_term: whole(last_primary_term, "lastPrimaryTerm")?,
        index_uuid: optional_filled(uuid, "indexUuid")?,
        sync_session: optional_filled(session, "syncSession")?,
    })
}

pub(crate) fn encode_sync_request(request: &SyncRequest) -> Vec<u8> {
    let mut out = Vec::with_capacity(request.index_name.len() + 160);
    let keys =
        4 + usize::from(request.index_uuid.is_some()) + usize::from(request.sync_session.is_some());
    write_map_header(&mut out, keys);
    write_str(&mut out, "indexName");
    write_str(&mut out, &request.index_name);
    write_str(&mut out, "partitionId");
    write_uint(&mut out, u64::from(request.partition_id));
    write_str(&mut out, "lastSeqNo");
    write_uint(&mut out, request.last_seq_no);
    write_str(&mut out, "lastPrimaryTerm");
    write_uint(&mut out, request.last_primary_term);
    if let Some(index_uuid) = &request.index_uuid {
        write_str(&mut out, "indexUuid");
        write_str(&mut out, index_uuid);
    }
    if let Some(sync_session) = &request.sync_session {
        write_str(&mut out, "syncSession");
        write_str(&mut out, sync_session);
    }
    out
}

pub(crate) fn encode_sync_entries(
    entries: &[WireEntry],
    is_last: bool,
    sync_session: &str,
) -> Vec<u8> {
    let bytes: usize = entries
        .iter()
        .map(|wire| wire.byte_estimate() as usize)
        .sum();
    let mut out = Vec::with_capacity(bytes + sync_session.len() + 48);
    write_map_header(&mut out, 3);
    write_str(&mut out, "entries");
    write_array_header(&mut out, entries.len());
    for wire in entries {
        write_entry(&mut out, wire);
    }
    write_str(&mut out, "isLast");
    write_bool(&mut out, is_last);
    write_str(&mut out, "syncSession");
    write_str(&mut out, sync_session);
    out
}

fn frame_invalid(message: &str) -> ClusterError {
    ClusterError::new(codes::SNAPSHOT_SYNC_FRAME_INVALID, message)
}

fn primary_error(fields: [Field<'_>; 2]) -> ClusterError {
    let [code, message] = fields;
    let code = code.text().unwrap_or("");
    let message = message.text().unwrap_or("");
    ClusterError::new(
        codes::SNAPSHOT_SYNC_PRIMARY_ERROR,
        format!("The primary refused the sync with {code}: {message}"),
    )
    .with_detail("primaryCode", Value::from(code))
    .with_detail("primaryMessage", Value::from(message))
}

pub(crate) fn decode_sync_frame(frame: &[u8]) -> ClusterResult<SyncFrame> {
    if wire::validate(frame).is_err() {
        return Err(ClusterError::new(
            codes::SNAPSHOT_SYNC_DECODE_FAILED,
            "failed to decode live sync frame",
        ));
    }
    let Some([error, code, message, entries, is_last, session]) = fields_of(
        frame,
        [
            "error",
            "code",
            "message",
            "entries",
            "isLast",
            "syncSession",
        ],
    ) else {
        return Err(frame_invalid("live sync frame is not an object"));
    };
    if error.flag() == Some(true) {
        return Err(primary_error([code, message]));
    }
    if !entries.has_key() && !is_last.has_key() {
        return Ok(SyncFrame::Snapshot);
    }
    let (Some(items), Some(is_last)) = (entries.items(), is_last.flag()) else {
        return Err(frame_invalid(
            "Invalid SyncEntriesPayload: expected entries array and isLast boolean",
        ));
    };
    let sync_session = session
        .optional(|value| value.filled_text().map(str::to_string))
        .ok_or_else(|| {
            frame_invalid(
                "Invalid SyncEntriesPayload: syncSession must be a non-empty string or absent",
            )
        })?;
    let mut decoded = Vec::with_capacity(items.len());
    for raw in items {
        decoded.push(decode_entry(raw, SYNC_ENTRIES_PAYLOAD)?);
    }
    Ok(SyncFrame::Entries {
        entries: decoded,
        is_last,
        sync_session,
    })
}

pub(crate) fn encode_insync_add(admission: &InsyncAdmission<'_>) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        admission.index_name.len()
            + admission.replica_node_id.len()
            + admission.replica_started_at.len()
            + 192,
    );
    write_map_header(&mut out, 8);
    write_str(&mut out, "indexName");
    write_str(&mut out, admission.index_name);
    write_str(&mut out, "partitionId");
    write_uint(&mut out, u64::from(admission.partition_id));
    write_str(&mut out, "replicaNodeId");
    write_str(&mut out, admission.replica_node_id);
    write_str(&mut out, "primaryTerm");
    write_uint(&mut out, admission.primary_term);
    write_str(&mut out, "appliedSeqNo");
    write_uint(&mut out, admission.applied_seq_no);
    write_str(&mut out, "commitPoint");
    write_uint(&mut out, admission.commit_point);
    write_str(&mut out, "inSyncVersion");
    write_uint(&mut out, admission.in_sync_version);
    write_str(&mut out, "replicaStartedAt");
    write_str(&mut out, admission.replica_started_at);
    out
}

pub(crate) fn encode_partition_stores_request(index_name: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(index_name.len() + 16);
    write_map_header(&mut out, 1);
    write_str(&mut out, "indexName");
    write_str(&mut out, index_name);
    out
}

pub(crate) fn stores_lists(
    payload: &[u8],
    index_name: &str,
    index_uuid: Option<&str>,
    partition_id: u32,
) -> bool {
    let Some([answered_name, answered_uuid, partition_ids]) =
        fields_of(payload, ["indexName", "indexUuid", "partitionIds"])
    else {
        return false;
    };
    if answered_name.text() != Some(index_name) {
        return false;
    }
    let Some(answered_uuid) = answered_uuid.filled_text() else {
        return false;
    };
    if index_uuid.is_some_and(|expected| expected != answered_uuid) {
        return false;
    }
    let Some(mut items) = partition_ids.items() else {
        return false;
    };
    items.any(|raw| {
        crate::wire::Reader::new(raw).read_whole_number().ok() == Some(u64::from(partition_id))
    })
}
