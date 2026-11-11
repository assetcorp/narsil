use super::entry::{LogEntry, decode_entry, encode_entry};
use super::{MAX_WAL_RECORD_BYTES, SEGMENT_HEADER_BYTES, WAL_MAGIC};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::util::hash::crc32;

pub(crate) const RECORD_LENGTH_BYTES: usize = 4;
pub(crate) const FRAME_CRC_BYTES: usize = 4;
pub(crate) const WAL_FORMAT_VERSION_AT: usize = 4;

/// The log framing version of a segment that holds no entry with a previous document.
pub(crate) const WAL_FORMAT_VERSION: u8 = 1;
/// The log framing version of a segment that can hold entries with a previous document.
pub(crate) const WAL_FORMAT_VERSION_WITH_PREVIOUS_DOCUMENT: u8 = 2;

pub(crate) fn segment_header(version: u8) -> [u8; SEGMENT_HEADER_BYTES] {
    let mut header = [0u8; SEGMENT_HEADER_BYTES];
    header[..4].copy_from_slice(&WAL_MAGIC);
    header[WAL_FORMAT_VERSION_AT] = version;
    header
}

/// Returns the log framing version that a segment's header gives, or `None` for a segment shorter than its header.
pub(crate) fn segment_version(data: &[u8]) -> Option<u8> {
    (data.len() >= SEGMENT_HEADER_BYTES).then(|| data[WAL_FORMAT_VERSION_AT])
}

pub(crate) fn frame_record(entry: &LogEntry, out: &mut Vec<u8>) -> Result<()> {
    let payload = encode_entry(entry);
    if payload.len() > MAX_WAL_RECORD_BYTES {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_SAVE_FAILED,
            format!(
                "A log record of {} bytes exceeds the limit of {MAX_WAL_RECORD_BYTES}",
                payload.len()
            ),
        ));
    }
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&crc32(&payload).to_be_bytes());
    Ok(())
}

fn corrupt(message: impl Into<String>) -> NarsilError {
    NarsilError::new(ErrorCode::PERSISTENCE_WAL_CORRUPT, message.into())
}

pub(crate) fn check_segment_header(data: &[u8]) -> Result<()> {
    if data.len() < SEGMENT_HEADER_BYTES {
        return Err(corrupt(
            "WAL segment header invalid in durable region: segment shorter than the 8-byte header",
        ));
    }
    if data[..4] != WAL_MAGIC {
        return Err(corrupt(
            "WAL segment header invalid in durable region: missing NRSW magic",
        ));
    }
    if data[WAL_FORMAT_VERSION_AT] > WAL_FORMAT_VERSION_WITH_PREVIOUS_DOCUMENT {
        return Err(NarsilError::new(
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            format!(
                "WAL segment header invalid in durable region: WAL format version {} is newer than supported version {WAL_FORMAT_VERSION_WITH_PREVIOUS_DOCUMENT}, so a newer release wrote this segment",
                data[WAL_FORMAT_VERSION_AT]
            ),
        ));
    }
    Ok(())
}

struct Frame<'a> {
    payload: &'a [u8],
    end: usize,
}

fn frame_at(
    data: &[u8],
    offset: usize,
    limit: usize,
) -> std::result::Result<Frame<'_>, &'static str> {
    if offset + RECORD_LENGTH_BYTES > limit {
        return Err("WAL record length field overruns the durable region");
    }
    let length = u32::from_be_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ]) as usize;
    if length == 0 || length > MAX_WAL_RECORD_BYTES {
        return Err("WAL record length is zero or exceeds the maximum record size");
    }
    let start = offset + RECORD_LENGTH_BYTES;
    let crc_start = start + length;
    let end = crc_start + FRAME_CRC_BYTES;
    if end > limit {
        return Err("WAL record overruns the durable region");
    }
    let payload = &data[start..crc_start];
    let stored = u32::from_be_bytes([
        data[crc_start],
        data[crc_start + 1],
        data[crc_start + 2],
        data[crc_start + 3],
    ]);
    if crc32(payload) != stored {
        return Err("WAL record failed its frame checksum inside the durable region");
    }
    Ok(Frame { payload, end })
}

/// Reads every record of the durable region, raising `PERSISTENCE_WAL_CORRUPT` for any damage inside it.
pub(crate) fn read_durable_region(
    data: &[u8],
    durable_byte_length: usize,
) -> Result<Vec<LogEntry>> {
    check_segment_header(data)?;
    if durable_byte_length < SEGMENT_HEADER_BYTES || durable_byte_length > data.len() {
        return Err(corrupt(
            "Commit marker durable byte length is outside the segment",
        ));
    }
    let mut entries: Vec<LogEntry> = Vec::new();
    let mut offset = SEGMENT_HEADER_BYTES;
    while offset < durable_byte_length {
        let frame = frame_at(data, offset, durable_byte_length).map_err(corrupt)?;
        let entry = decode_entry(frame.payload).map_err(|error| {
            corrupt(format!(
                "WAL record payload failed to decode inside the durable region: {}",
                error.message()
            ))
        })?;
        if entries
            .last()
            .is_some_and(|last| entry.seq_no <= last.seq_no)
        {
            return Err(corrupt("WAL sequence numbers are not strictly increasing"));
        }
        entries.push(entry);
        offset = frame.end;
    }
    Ok(entries)
}

/// Reads the records past the durable region up to the first damaged or out-of-order record.
pub(crate) fn read_tail(
    data: &[u8],
    durable_byte_length: usize,
    last_durable_seq_no: f64,
) -> (Vec<LogEntry>, usize) {
    let start = durable_byte_length.max(SEGMENT_HEADER_BYTES);
    let mut entries = Vec::new();
    let mut offset = start;
    let mut previous = last_durable_seq_no;
    while offset < data.len() {
        let Ok(frame) = frame_at(data, offset, data.len()) else {
            break;
        };
        let Ok(entry) = decode_entry(frame.payload) else {
            break;
        };
        if entry.seq_no <= previous {
            break;
        }
        previous = entry.seq_no;
        entries.push(entry);
        offset = frame.end;
    }
    (entries, offset)
}
