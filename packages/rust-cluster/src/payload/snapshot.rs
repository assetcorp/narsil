use super::fields::{Field, fields_of};
use crate::wire::{write_bin, write_map_header, write_str, write_uint};

/// The `ReplicationSnapshotHeader` that a `replication.snapshot_start` carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SnapshotHeader {
    pub(crate) last_seq_no: u64,
    pub(crate) primary_term: u64,
    pub(crate) partition_id: u32,
    pub(crate) index_name: String,
    pub(crate) checksum: u64,
}

/// The fields of a `replication.snapshot_start` whose values hold the types that the payload declares.
pub(crate) struct SnapshotStart {
    pub(crate) header: Option<SnapshotHeader>,
    pub(crate) header_shaped: bool,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) sync_session: Option<Option<String>>,
}

/// A later payload of a snapshot answer, by the keys that it holds.
pub(crate) enum SnapshotPart<'a> {
    Chunk {
        partition_id: Option<u64>,
        index_name: &'a str,
        offset: Option<u64>,
        data: Option<&'a [u8]>,
    },
    End {
        partition_id: Option<u64>,
        index_name: &'a str,
        total_bytes: Option<u64>,
        checksum: Option<u64>,
    },
    Unknown,
}

fn is_number(field: Field<'_>) -> bool {
    field.present().is_some_and(|raw| {
        matches!(
            raw.first(),
            Some(0x00..=0x7f | 0xca | 0xcb | 0xcc..=0xcf | 0xd0..=0xd3 | 0xe0..=0xff)
        )
    })
}

pub(crate) fn encode_snapshot_start(
    header: &SnapshotHeader,
    total_bytes: u64,
    sync_session: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(header.index_name.len() + sync_session.len() + 160);
    write_map_header(&mut out, 3);
    write_str(&mut out, "header");
    write_map_header(&mut out, 5);
    write_str(&mut out, "lastSeqNo");
    write_uint(&mut out, header.last_seq_no);
    write_str(&mut out, "primaryTerm");
    write_uint(&mut out, header.primary_term);
    write_str(&mut out, "partitionId");
    write_uint(&mut out, u64::from(header.partition_id));
    write_str(&mut out, "indexName");
    write_str(&mut out, &header.index_name);
    write_str(&mut out, "checksum");
    write_uint(&mut out, header.checksum);
    write_str(&mut out, "totalBytes");
    write_uint(&mut out, total_bytes);
    write_str(&mut out, "syncSession");
    write_str(&mut out, sync_session);
    out
}

pub(crate) fn encode_snapshot_chunk(
    index_name: &str,
    partition_id: u32,
    offset: u64,
    data: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(index_name.len() + data.len() + 64);
    write_map_header(&mut out, 4);
    write_str(&mut out, "partitionId");
    write_uint(&mut out, u64::from(partition_id));
    write_str(&mut out, "indexName");
    write_str(&mut out, index_name);
    write_str(&mut out, "offset");
    write_uint(&mut out, offset);
    write_str(&mut out, "data");
    write_bin(&mut out, data);
    out
}

pub(crate) fn encode_snapshot_end(
    index_name: &str,
    partition_id: u32,
    total_bytes: u64,
    checksum: u64,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(index_name.len() + 64);
    write_map_header(&mut out, 4);
    write_str(&mut out, "partitionId");
    write_uint(&mut out, u64::from(partition_id));
    write_str(&mut out, "indexName");
    write_str(&mut out, index_name);
    write_str(&mut out, "totalBytes");
    write_uint(&mut out, total_bytes);
    write_str(&mut out, "checksum");
    write_uint(&mut out, checksum);
    out
}

fn decoded_header(raw: Option<&[u8]>) -> (bool, Option<SnapshotHeader>) {
    let Some(raw) = raw else {
        return (false, None);
    };
    let Some(
        [
            last_seq_no,
            primary_term,
            partition_id,
            index_name,
            checksum,
        ],
    ) = fields_of(
        raw,
        [
            "lastSeqNo",
            "primaryTerm",
            "partitionId",
            "indexName",
            "checksum",
        ],
    )
    else {
        return (false, None);
    };
    let shaped = index_name.text().is_some()
        && [last_seq_no, primary_term, partition_id, checksum]
            .into_iter()
            .all(is_number);
    let header = (|| {
        Some(SnapshotHeader {
            last_seq_no: last_seq_no.count()?,
            primary_term: primary_term.count()?,
            partition_id: partition_id.count_u32()?,
            index_name: index_name.text()?.to_string(),
            checksum: checksum.count()?,
        })
    })();
    (shaped, header)
}

pub(crate) fn decode_snapshot_start(frame: &[u8]) -> SnapshotStart {
    let Some([header, total_bytes, session]) =
        fields_of(frame, ["header", "totalBytes", "syncSession"])
    else {
        return SnapshotStart {
            header: None,
            header_shaped: false,
            total_bytes: None,
            sync_session: None,
        };
    };
    let (header_shaped, decoded) = decoded_header(header.present());
    SnapshotStart {
        header: decoded,
        header_shaped: header_shaped && is_number(total_bytes),
        total_bytes: total_bytes.count(),
        sync_session: session.optional(|value| value.filled_text().map(str::to_string)),
    }
}

pub(crate) fn decode_snapshot_part(frame: &[u8]) -> SnapshotPart<'_> {
    let Some(
        [
            partition_id,
            index_name,
            offset,
            data,
            total_bytes,
            checksum,
        ],
    ) = fields_of(
        frame,
        [
            "partitionId",
            "indexName",
            "offset",
            "data",
            "totalBytes",
            "checksum",
        ],
    )
    else {
        return SnapshotPart::Unknown;
    };
    let Some(name) = index_name.text() else {
        return SnapshotPart::Unknown;
    };
    if !is_number(partition_id) {
        return SnapshotPart::Unknown;
    }
    let has_data = data.binary().is_some();
    let (has_offset, has_total, has_checksum) = (
        is_number(offset),
        is_number(total_bytes),
        is_number(checksum),
    );
    if has_offset && has_data && !has_checksum && !has_total {
        return SnapshotPart::Chunk {
            partition_id: partition_id.count(),
            index_name: name,
            offset: offset.count(),
            data: data.binary(),
        };
    }
    if has_total && has_checksum && !has_offset && !has_data {
        return SnapshotPart::End {
            partition_id: partition_id.count(),
            index_name: name,
            total_bytes: total_bytes.count(),
            checksum: checksum.count(),
        };
    }
    SnapshotPart::Unknown
}
