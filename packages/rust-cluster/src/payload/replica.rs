use narsil::replication::{EntryOperation, ReplicatedEntry};

use super::entry::{DELETE_OPERATION, INDEX_OPERATION, WireEntry};
use super::fields::Field;
use super::term_start::{HeldEnd, TermStart, count_of};
use super::{index_uuid, invalid_entry, members};
use crate::error::ClusterResult;
use crate::wire::{write_map_header, write_str, write_uint};

const ENTRY_PAYLOAD: &str = "EntryPayload";
const ENTRY_BATCH_PAYLOAD: &str = "EntryBatchPayload";
const TERM_START_PAYLOAD: &str = "TermStartPayload";

pub(crate) struct EntryRun {
    pub(crate) entries: Vec<WireEntry>,
    pub(crate) index_uuid: Option<String>,
    pub(crate) previous_primary_term: Option<u64>,
}

pub(crate) fn holds_checksum(wire: &WireEntry) -> bool {
    wire.entry.checksum(&wire.index_name, wire.partition_id) == wire.checksum
}

pub(crate) fn encode_ack(index_name: &str, partition_id: u32, seq_no: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(index_name.len() + 48);
    write_map_header(&mut out, 3);
    write_str(&mut out, "seqNo");
    write_uint(&mut out, seq_no);
    write_str(&mut out, "partitionId");
    write_uint(&mut out, u64::from(partition_id));
    write_str(&mut out, "indexName");
    write_str(&mut out, index_name);
    out
}

fn text_of<'a>(field: Field<'a>, payload_name: &str, rule: &str) -> ClusterResult<&'a str> {
    field
        .text()
        .ok_or_else(|| invalid_entry(payload_name, rule))
}

fn number_of(field: Field<'_>, payload_name: &str, rule: &str) -> ClusterResult<u64> {
    field
        .count()
        .ok_or_else(|| invalid_entry(payload_name, rule))
}

fn document_of(field: Field<'_>, payload_name: &str, rule: &str) -> ClusterResult<Option<Vec<u8>>> {
    match field.present() {
        None => Ok(None),
        Some(_) => field
            .binary()
            .map(|bytes| Some(bytes.to_vec()))
            .ok_or_else(|| invalid_entry(payload_name, rule)),
    }
}

pub(crate) fn decode_entry(raw: &[u8], payload_name: &str) -> ClusterResult<WireEntry> {
    let [
        seq_no,
        primary_term,
        operation,
        partition_id,
        index_name,
        document_id,
        document,
        previous_document,
        checksum,
    ] = members(
        raw,
        [
            "seqNo",
            "primaryTerm",
            "operation",
            "partitionId",
            "indexName",
            "documentId",
            "document",
            "previousDocument",
            "checksum",
        ],
        payload_name,
    )?;
    let seq_no = number_of(
        seq_no,
        payload_name,
        "\"entry.seqNo\" must be a non-negative integer",
    )?;
    let primary_term = number_of(
        primary_term,
        payload_name,
        "\"entry.primaryTerm\" must be a non-negative integer",
    )?;
    let operation = match operation.text() {
        Some(INDEX_OPERATION) => EntryOperation::Index,
        Some(DELETE_OPERATION) => EntryOperation::Delete,
        _ => {
            return Err(invalid_entry(
                payload_name,
                "\"entry.operation\" must be \"INDEX\" or \"DELETE\"",
            ));
        }
    };
    let partition_id = partition_id.count_u32().ok_or_else(|| {
        invalid_entry(
            payload_name,
            "\"entry.partitionId\" must be a partition number",
        )
    })?;
    let index_name = text_of(
        index_name,
        payload_name,
        "\"entry.indexName\" must be a string",
    )?;
    let document_id = text_of(
        document_id,
        payload_name,
        "\"entry.documentId\" must be a string",
    )?;
    let document = document_of(
        document,
        payload_name,
        "\"entry.document\" must be binary or absent",
    )?;
    let previous_document = if previous_document.has_key() {
        Some(document_of(
            previous_document,
            payload_name,
            "\"entry.previousDocument\" must be binary or nil where present",
        )?)
    } else {
        None
    };
    let checksum = u32::try_from(number_of(
        checksum,
        payload_name,
        "\"entry.checksum\" must be a CRC32",
    )?)
    .map_err(|_| invalid_entry(payload_name, "\"entry.checksum\" must be a CRC32"))?;
    Ok(WireEntry {
        index_name: index_name.to_string(),
        partition_id,
        entry: ReplicatedEntry {
            seq_no,
            primary_term,
            operation,
            document_id: document_id.to_string(),
            document,
            previous_document,
        },
        checksum,
    })
}

fn previous_term(field: Field<'_>, payload_name: &str) -> ClusterResult<Option<u64>> {
    field.optional(Field::count).ok_or_else(|| {
        invalid_entry(
            payload_name,
            "\"previousPrimaryTerm\" must be a non-negative integer or absent",
        )
    })
}

fn contiguous(entries: &[WireEntry]) -> ClusterResult<()> {
    let Some(first) = entries.first() else {
        return Err(invalid_entry(
            ENTRY_BATCH_PAYLOAD,
            "\"entries\" must not be empty",
        ));
    };
    for pair in entries.windows(2) {
        let [before, after] = pair else {
            continue;
        };
        if after.index_name != first.index_name || after.partition_id != first.partition_id {
            return Err(invalid_entry(
                ENTRY_BATCH_PAYLOAD,
                "entries must belong to one partition of one index",
            ));
        }
        if after.entry.primary_term != first.entry.primary_term {
            return Err(invalid_entry(
                ENTRY_BATCH_PAYLOAD,
                "entries must share one primary term",
            ));
        }
        if before.entry.seq_no.checked_add(1) != Some(after.entry.seq_no) {
            return Err(invalid_entry(
                ENTRY_BATCH_PAYLOAD,
                "entries must carry contiguous ascending sequence numbers",
            ));
        }
    }
    Ok(())
}

pub(crate) fn decode_entry_payload(payload: &[u8]) -> ClusterResult<EntryRun> {
    let [entry, uuid, previous] = members(
        payload,
        ["entry", "indexUuid", "previousPrimaryTerm"],
        ENTRY_PAYLOAD,
    )?;
    let raw = entry
        .present()
        .ok_or_else(|| invalid_entry(ENTRY_PAYLOAD, "missing or invalid \"entry\" field"))?;
    let decoded = decode_entry(raw, ENTRY_PAYLOAD)?;
    Ok(EntryRun {
        entries: vec![decoded],
        index_uuid: index_uuid(uuid, ENTRY_PAYLOAD)?,
        previous_primary_term: previous_term(previous, ENTRY_PAYLOAD)?,
    })
}

pub(crate) fn decode_entry_batch_payload(payload: &[u8]) -> ClusterResult<EntryRun> {
    let [entries, uuid, previous] = members(
        payload,
        ["entries", "indexUuid", "previousPrimaryTerm"],
        ENTRY_BATCH_PAYLOAD,
    )?;
    let items = entries.items().ok_or_else(|| {
        invalid_entry(ENTRY_BATCH_PAYLOAD, "missing or invalid \"entries\" field")
    })?;
    let mut decoded = Vec::new();
    for raw in items {
        decoded.push(decode_entry(raw, ENTRY_BATCH_PAYLOAD)?);
    }
    contiguous(&decoded)?;
    Ok(EntryRun {
        entries: decoded,
        index_uuid: index_uuid(uuid, ENTRY_BATCH_PAYLOAD)?,
        previous_primary_term: previous_term(previous, ENTRY_BATCH_PAYLOAD)?,
    })
}

pub(crate) fn decode_term_start(payload: &[u8]) -> ClusterResult<TermStart> {
    let [
        index_name,
        partition_id,
        primary_term,
        last_seq_no,
        last_primary_term,
        uuid,
    ] = members(
        payload,
        [
            "indexName",
            "partitionId",
            "primaryTerm",
            "lastSeqNo",
            "lastPrimaryTerm",
            "indexUuid",
        ],
        TERM_START_PAYLOAD,
    )?;
    let index_name = index_name.filled_text().ok_or_else(|| {
        invalid_entry(
            TERM_START_PAYLOAD,
            "\"indexName\" must be a non-empty string",
        )
    })?;
    let partition_id = partition_id.count_u32().ok_or_else(|| {
        invalid_entry(
            TERM_START_PAYLOAD,
            "\"partitionId\" must be a non-negative integer",
        )
    })?;
    Ok(TermStart {
        index_name: index_name.to_string(),
        partition_id,
        primary_term: count_of(primary_term, "primaryTerm", TERM_START_PAYLOAD)?,
        last_seq_no: count_of(last_seq_no, "lastSeqNo", TERM_START_PAYLOAD)?,
        last_primary_term: count_of(last_primary_term, "lastPrimaryTerm", TERM_START_PAYLOAD)?,
        index_uuid: index_uuid(uuid, TERM_START_PAYLOAD)?,
    })
}

pub(crate) fn encode_term_start_ack(index_name: &str, partition_id: u32, held: HeldEnd) -> Vec<u8> {
    let mut out = Vec::with_capacity(index_name.len() + 96);
    write_map_header(&mut out, 4);
    write_str(&mut out, "indexName");
    write_str(&mut out, index_name);
    write_str(&mut out, "partitionId");
    write_uint(&mut out, u64::from(partition_id));
    write_str(&mut out, "lastSeqNo");
    write_uint(&mut out, held.last_seq_no);
    write_str(&mut out, "lastPrimaryTerm");
    write_uint(&mut out, held.last_primary_term);
    out
}
