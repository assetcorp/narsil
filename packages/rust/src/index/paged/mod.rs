mod cache;
mod documents;
mod file;
mod ids;
mod lists;
mod materialise;
mod open;
mod page_cache;
mod resident;

pub(crate) use cache::merge_cache_scope;
pub(crate) use file::{PagedFile, paged_read};
pub(crate) use lists::{PostingList, PostingPositions};
pub(crate) use open::{PagedListing, open_paged_segment, resident_section_bytes};

use documents::BlockEntry;

use crate::format::paged_segment::head::PagedSection;

/// The sections of a paged keyword segment that stay in its file, with the open file that a search reads them
/// from one page at a time.
pub(crate) struct PagedSections {
    key: String,
    file: PagedFile,
    document_count: u32,
    field_count: usize,
    postings: PagedSection,
    token_totals: Option<PagedSection>,
    position_offsets: Option<PagedSection>,
    positions: Option<PagedSection>,
    documents: PagedSection,
    ids: PagedSection,
    id_offsets: PagedSection,
    id_order: PagedSection,
    removal_offsets: PagedSection,
    removals: PagedSection,
    seq_nos: Option<PagedSection>,
    primary_terms: Option<PagedSection>,
    document_blocks: Vec<BlockEntry>,
    id_sample: Vec<(String, u32)>,
}

impl PagedSections {
    pub(crate) fn holds_write_records(&self) -> bool {
        self.seq_nos.is_some() && self.primary_terms.is_some()
    }
}
