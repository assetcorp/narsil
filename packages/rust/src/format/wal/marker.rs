use super::{COMMIT_MARKER_SLOT_BYTES, COMMIT_MARKER_SLOTS};
use crate::util::hash::crc32;
use crate::value::MAX_SAFE_INTEGER;

const MARKER_CRC_OFFSET: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CommitMarker {
    pub(crate) write_seq: u64,
    pub(crate) active_segment_seq_no: u64,
    pub(crate) durable_byte_length: u64,
    pub(crate) highest_durable_seq_no: u64,
}

pub(crate) fn encode_marker_slot(state: &CommitMarker) -> [u8; COMMIT_MARKER_SLOT_BYTES] {
    let mut slot = [0u8; COMMIT_MARKER_SLOT_BYTES];
    slot[0..8].copy_from_slice(&state.write_seq.to_be_bytes());
    slot[8..16].copy_from_slice(&state.active_segment_seq_no.to_be_bytes());
    slot[16..24].copy_from_slice(&state.durable_byte_length.to_be_bytes());
    slot[24..32].copy_from_slice(&state.highest_durable_seq_no.to_be_bytes());
    let crc = crc32(&slot[..MARKER_CRC_OFFSET]);
    slot[MARKER_CRC_OFFSET..].copy_from_slice(&crc.to_be_bytes());
    slot
}

pub(crate) fn decode_marker_slot(data: &[u8], slot_index: usize) -> Option<CommitMarker> {
    let base = slot_index * COMMIT_MARKER_SLOT_BYTES;
    let slot = data.get(base..base + COMMIT_MARKER_SLOT_BYTES)?;
    let stored = u32::from_be_bytes(slot[MARKER_CRC_OFFSET..].try_into().ok()?);
    if crc32(&slot[..MARKER_CRC_OFFSET]) != stored {
        return None;
    }
    let field = |at: usize| u64::from_be_bytes(slot[at..at + 8].try_into().unwrap_or([0xff; 8]));
    let state = CommitMarker {
        write_seq: field(0),
        active_segment_seq_no: field(8),
        durable_byte_length: field(16),
        highest_durable_seq_no: field(24),
    };
    let fields = [
        state.write_seq,
        state.active_segment_seq_no,
        state.durable_byte_length,
        state.highest_durable_seq_no,
    ];
    fields
        .iter()
        .all(|value| *value <= MAX_SAFE_INTEGER)
        .then_some(state)
}

/// Returns the valid slot with the highest write sequence, and its index.
pub(crate) fn read_commit_marker(data: &[u8]) -> Option<(CommitMarker, usize)> {
    let mut best: Option<(CommitMarker, usize)> = None;
    for slot_index in 0..COMMIT_MARKER_SLOTS {
        let Some(state) = decode_marker_slot(data, slot_index) else {
            continue;
        };
        if best.is_none_or(|(current, _)| state.write_seq > current.write_seq) {
            best = Some((state, slot_index));
        }
    }
    best
}
