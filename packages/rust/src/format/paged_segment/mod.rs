pub(crate) mod assemble;
pub(crate) mod blocks;
pub(crate) mod constants;
pub(crate) mod head;
pub(crate) mod removal_sort;
pub(crate) mod sink;
mod write;
pub(crate) mod write_lists;

pub(crate) use write::{
    TokenSections, encode_id_sample, encode_paged_segment, head_of, resident_sections,
    surface_section,
};

pub(crate) const PAGED_SEGMENT_ENVELOPE_VERSION: u8 = 6;
pub(crate) const PAGED_SEGMENT_HEAD_VERSION: u8 = 1;
pub(crate) const SEGMENT_PAGE_BYTES: u64 = 65_536;
pub(crate) const PAYLOAD_PREFIX_BYTES: usize = 8;
pub(crate) const SECTION_ALIGNMENT_BYTES: u64 = 4;
pub(crate) const POSTING_WIDTH_BYTES: u64 = 8;
pub(crate) const SMALLEST_BLOCK_POSTINGS: usize = 128;
pub(crate) const DOCUMENT_BLOCK_MIN_RAW_BYTES: usize = 65_536;
pub(crate) const MAX_DOCUMENT_BLOCK_RAW_BYTES: u32 = 16_842_752;
pub(crate) const ID_SAMPLE_INTERVAL: usize = 256;
pub(crate) const BLOCK_SUMMARY_BYTES: usize = 22;
pub(crate) const DOCUMENT_BLOCK_BYTES: usize = 20;
