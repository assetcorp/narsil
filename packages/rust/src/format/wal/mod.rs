mod entry;
mod marker;
mod segment;

pub(crate) use entry::{LogEntry, Operation, entry_checksum};
pub(crate) use marker::{CommitMarker, decode_marker_slot, encode_marker_slot, read_commit_marker};
pub(crate) use segment::{
    check_segment_header, frame_record, read_durable_region, read_tail, segment_header,
};

pub(crate) const WAL_MAGIC: [u8; 4] = *b"NRSW";
pub(crate) const WAL_FORMAT_VERSION: u8 = 1;
pub(crate) const SEGMENT_HEADER_BYTES: usize = 8;
pub(crate) const MAX_WAL_RECORD_BYTES: usize = 268_435_456;
pub(crate) const COMMIT_MARKER_SLOT_BYTES: usize = 36;
pub(crate) const COMMIT_MARKER_SLOTS: usize = 2;
pub(crate) const COMMIT_MARKER_FILE_BYTES: usize = COMMIT_MARKER_SLOT_BYTES * COMMIT_MARKER_SLOTS;
