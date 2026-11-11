use std::path::PathBuf;

use super::PagedSections;
use super::file::PagedFile;
use super::resident::{read_resident, resident_bytes};
use crate::error::{ErrorCode, NarsilError, Result, load_failed};
use crate::format::envelope::{HEADER_BYTES, read_header};
use crate::format::keyword_segment::KeywordSegment;
use crate::format::paged_segment::head::{PagedHead, PagedSection, decode_paged_head};
use crate::format::paged_segment::{PAGED_SEGMENT_ENVELOPE_VERSION, PAYLOAD_PREFIX_BYTES};
use crate::util::hash::crc32;

/// A paged segment file as the manifest lists it.
pub(crate) struct PagedListing {
    pub(crate) key: String,
    pub(crate) path: PathBuf,
    pub(crate) bytes: u64,
    pub(crate) checksum: u32,
}

fn opened_file(listing: &PagedListing) -> Result<PagedFile> {
    let key = &listing.key;
    if !listing.path.exists() {
        return load_failed(format!(
            "The segment \"{key}\" that the manifest lists is missing"
        ));
    }
    let file = PagedFile::open(&listing.path)?;
    let length = file.length()?;
    if length != listing.bytes {
        return load_failed(format!(
            "The segment \"{key}\" holds {length} bytes where the manifest lists {}",
            listing.bytes
        ));
    }
    Ok(file)
}

fn read_head(file: &PagedFile, listing: &PagedListing) -> Result<PagedHead> {
    let key = &listing.key;
    let mut start = [0u8; HEADER_BYTES + PAYLOAD_PREFIX_BYTES];
    if listing.bytes < start.len() as u64 {
        return load_failed(format!("The segment \"{key}\" is too short to hold a head"));
    }
    file.read_into(0, &mut start)?;
    let header = read_header(&start)?;
    if header.envelope_format_version != PAGED_SEGMENT_ENVELOPE_VERSION {
        return Err(NarsilError::new(
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            format!(
                "The segment \"{key}\" holds envelope format v{}",
                header.envelope_format_version
            ),
        ));
    }
    if header.compressed {
        return load_failed(format!(
            "The segment \"{key}\" is compressed, while its format stores it raw"
        ));
    }
    let payload_length = u64::from(header.payload_length);
    if HEADER_BYTES as u64 + payload_length != listing.bytes {
        return load_failed(format!(
            "The segment \"{key}\" holds {} bytes where its header gives {}",
            listing.bytes,
            HEADER_BYTES as u64 + payload_length
        ));
    }
    if header.checksum != listing.checksum {
        return load_failed(format!(
            "The segment \"{key}\" carries checksum {} where the manifest lists {}",
            header.checksum, listing.checksum
        ));
    }
    let prefix = &start[HEADER_BYTES..];
    let head_length = u32::from_le_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]);
    let head_checksum = u32::from_le_bytes([prefix[4], prefix[5], prefix[6], prefix[7]]);
    if PAYLOAD_PREFIX_BYTES as u64 + u64::from(head_length) > payload_length {
        return load_failed(format!(
            "The head of the segment \"{key}\" ends outside its payload"
        ));
    }
    let mut head = vec![0u8; head_length as usize];
    file.read_into((HEADER_BYTES + PAYLOAD_PREFIX_BYTES) as u64, &mut head)?;
    if crc32(&head) != head_checksum {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_CRC_MISMATCH,
            format!("The head of the segment \"{key}\" fails its checksum"),
        ));
    }
    decode_paged_head(&head, payload_length, &format!("the segment \"{key}\""))
}

/// Returns the bytes that an index holds in memory once it opens the paged segment, which are the bytes of the
/// sections that it reads whole, reading only the segment's header and head.
pub(crate) fn resident_section_bytes(listing: &PagedListing) -> Result<u64> {
    let file = opened_file(listing)?;
    let head = read_head(&file, listing)?;
    Ok(resident_bytes(&head))
}

pub(super) fn required(head: &PagedHead, name: &str, key: &str) -> Result<PagedSection> {
    head.section(name).cloned().map_or_else(
        || load_failed(format!("The segment \"{key}\" holds no section \"{name}\"")),
        Ok,
    )
}

/// Opens a paged keyword segment: checks its header against the manifest, its head, and every page and rule of
/// its resident sections, then returns those sections as a keyword segment that holds no postings, IDs, or
/// documents, beside the sections that searches read from the file.
pub(crate) fn open_paged_segment(
    listing: &PagedListing,
) -> Result<(KeywordSegment, PagedSections)> {
    let file = opened_file(listing)?;
    let head = read_head(&file, listing)?;
    let key = listing.key.as_str();
    let resident = read_resident(&file, &head, key)?;
    let optional = |name: &str| head.section(name).cloned();
    let position_offsets = optional("positionOffsets");
    let positions = optional("positions");
    if position_offsets.is_some() != positions.is_some() {
        return load_failed(format!(
            "The segment \"{key}\" holds one of positionOffsets and positions"
        ));
    }
    let sections = PagedSections {
        key: key.to_string(),
        document_count: head.document_count,
        field_count: head.field_names.len(),
        postings: required(&head, "postings", key)?,
        token_totals: optional("tokenTotals"),
        position_offsets,
        positions,
        documents: required(&head, "documents", key)?,
        ids: required(&head, "ids", key)?,
        id_offsets: required(&head, "idOffsets", key)?,
        id_order: required(&head, "idOrder", key)?,
        removal_offsets: required(&head, "removalOffsets", key)?,
        removals: required(&head, "removals", key)?,
        seq_nos: optional("seqNos"),
        primary_terms: optional("primaryTerms"),
        document_blocks: resident.document_blocks,
        id_sample: resident.id_sample,
        file,
    };
    Ok((resident.segment, sections))
}
