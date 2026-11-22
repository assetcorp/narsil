use super::fields::{Field, fields_of};
use super::invalid_entry;
use crate::error::ClusterResult;
use crate::wire::{write_map_header, write_str, write_uint};

const TERM_START_ACK_PAYLOAD: &str = "TermStartAckPayload";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TermStart {
    pub(crate) index_name: String,
    pub(crate) partition_id: u32,
    pub(crate) primary_term: u64,
    pub(crate) last_seq_no: u64,
    pub(crate) last_primary_term: u64,
    pub(crate) index_uuid: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HeldEnd {
    pub(crate) last_seq_no: u64,
    pub(crate) last_primary_term: u64,
}

pub(super) fn count_of(field: Field<'_>, name: &str, payload_name: &str) -> ClusterResult<u64> {
    field.count().ok_or_else(|| {
        invalid_entry(
            payload_name,
            &format!("\"{name}\" must be a non-negative integer"),
        )
    })
}

pub(crate) fn encode_term_start(start: &TermStart) -> Vec<u8> {
    let mut out = Vec::with_capacity(start.index_name.len() + 128);
    write_map_header(&mut out, 5 + usize::from(start.index_uuid.is_some()));
    write_str(&mut out, "indexName");
    write_str(&mut out, &start.index_name);
    write_str(&mut out, "partitionId");
    write_uint(&mut out, u64::from(start.partition_id));
    write_str(&mut out, "primaryTerm");
    write_uint(&mut out, start.primary_term);
    write_str(&mut out, "lastSeqNo");
    write_uint(&mut out, start.last_seq_no);
    write_str(&mut out, "lastPrimaryTerm");
    write_uint(&mut out, start.last_primary_term);
    if let Some(uuid) = &start.index_uuid {
        write_str(&mut out, "indexUuid");
        write_str(&mut out, uuid);
    }
    out
}

pub(crate) fn term_start_ack_of(payload: &[u8], request: &TermStart) -> Option<HeldEnd> {
    let [index_name, partition_id, last_seq_no, last_primary_term] = fields_of(
        payload,
        ["indexName", "partitionId", "lastSeqNo", "lastPrimaryTerm"],
    )?;
    if index_name.filled_text()? != request.index_name
        || partition_id.count_u32()? != request.partition_id
    {
        return None;
    }
    let held = HeldEnd {
        last_seq_no: count_of(last_seq_no, "lastSeqNo", TERM_START_ACK_PAYLOAD).ok()?,
        last_primary_term: count_of(last_primary_term, "lastPrimaryTerm", TERM_START_ACK_PAYLOAD)
            .ok()?,
    };
    Some(held)
}
