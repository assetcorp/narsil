use narsil::replication::{EntryOperation, ReplicatedEntry};

use crate::wire::{write_bin, write_map_header, write_nil, write_str, write_uint};

pub(crate) const INDEX_OPERATION: &str = "INDEX";
pub(crate) const DELETE_OPERATION: &str = "DELETE";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WireEntry {
    pub(crate) index_name: String,
    pub(crate) partition_id: u32,
    pub(crate) entry: ReplicatedEntry,
    pub(crate) checksum: u32,
}

impl WireEntry {
    pub(crate) fn of(index_name: &str, partition_id: u32, entry: ReplicatedEntry) -> WireEntry {
        let checksum = entry.checksum(index_name, partition_id);
        WireEntry {
            index_name: index_name.to_string(),
            partition_id,
            entry,
            checksum,
        }
    }

    pub(crate) fn byte_estimate(&self) -> u64 {
        let previous = match &self.entry.previous_document {
            Some(Some(document)) => document.len(),
            _ => 0,
        };
        let document = self.entry.document.as_ref().map_or(0, Vec::len);
        (crate::constants::REPLICATION_ENTRY_FIXED_OVERHEAD_BYTES
            + self.index_name.len()
            + self.entry.document_id.len()
            + document
            + previous) as u64
    }
}

pub(crate) fn write_entry(out: &mut Vec<u8>, wire: &WireEntry) {
    let entry = &wire.entry;
    let keys = if entry.previous_document.is_some() {
        9
    } else {
        8
    };
    write_map_header(out, keys);
    write_str(out, "seqNo");
    write_uint(out, entry.seq_no);
    write_str(out, "primaryTerm");
    write_uint(out, entry.primary_term);
    write_str(out, "operation");
    write_str(
        out,
        match entry.operation {
            EntryOperation::Index => INDEX_OPERATION,
            EntryOperation::Delete => DELETE_OPERATION,
        },
    );
    write_str(out, "partitionId");
    write_uint(out, u64::from(wire.partition_id));
    write_str(out, "indexName");
    write_str(out, &wire.index_name);
    write_str(out, "documentId");
    write_str(out, &entry.document_id);
    write_str(out, "document");
    match &entry.document {
        Some(document) => write_bin(out, document),
        None => write_nil(out),
    }
    if let Some(previous) = &entry.previous_document {
        write_str(out, "previousDocument");
        match previous {
            Some(document) => write_bin(out, document),
            None => write_nil(out),
        }
    }
    write_str(out, "checksum");
    write_uint(out, u64::from(wire.checksum));
}

fn write_run_tail(out: &mut Vec<u8>, index_uuid: Option<&str>, previous_primary_term: Option<u64>) {
    if let Some(index_uuid) = index_uuid {
        write_str(out, "indexUuid");
        write_str(out, index_uuid);
    }
    if let Some(term) = previous_primary_term {
        write_str(out, "previousPrimaryTerm");
        write_uint(out, term);
    }
}

pub(crate) fn encode_entry_run(
    entries: &[WireEntry],
    index_uuid: Option<&str>,
    previous_primary_term: Option<u64>,
) -> Vec<u8> {
    let bytes: usize = entries
        .iter()
        .map(|wire| wire.byte_estimate() as usize)
        .sum();
    let mut out = Vec::with_capacity(bytes + 64);
    let keys = 1 + usize::from(index_uuid.is_some()) + usize::from(previous_primary_term.is_some());
    write_map_header(&mut out, keys);
    if let [single] = entries {
        write_str(&mut out, "entry");
        write_entry(&mut out, single);
    } else {
        write_str(&mut out, "entries");
        crate::wire::write_array_header(&mut out, entries.len());
        for wire in entries {
            write_entry(&mut out, wire);
        }
    }
    write_run_tail(&mut out, index_uuid, previous_primary_term);
    out
}
