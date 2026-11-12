use super::documents::BlockEntry;
use super::file::PagedFile;
use super::open::required;
use crate::error::{ErrorCode, Result, load_failed};
use crate::format::fields::Fields;
use crate::format::keyword_segment::{KeywordSegment, MAX_SEGMENT_FIELD_NAMES};
use crate::format::paged_segment::head::PagedHead;
use crate::format::paged_segment::{
    BLOCK_SUMMARY_BYTES, DOCUMENT_BLOCK_BYTES, MAX_DOCUMENT_BLOCK_RAW_BYTES, POSTING_WIDTH_BYTES,
    SMALLEST_BLOCK_POSTINGS,
};
use crate::format::segment_checks::{
    require_entries_ascend, require_offsets, require_utf8_entries,
};
use crate::schema::require_valid_field_types;
use crate::util::bytes::le_u32;
use crate::value::{Map, Value, decode_value};

const ERROR_PREFIX: &str = "Invalid keyword segment: ";
const RESIDENT_LISTS: [&str; 8] = [
    "fieldLengths",
    "numeric",
    "sizes",
    "boolean",
    "enum",
    "geopoint",
    "pattern",
    "partialWords",
];

const RESIDENT_TABLES: [&str; 9] = [
    "tokens",
    "tokenOffsets",
    "documentFrequencies",
    "postingOffsets",
    "blockLists",
    "blockListOffsets",
    "blockSummaries",
    "documentBlocks",
    "idSample",
];
const SURFACE_FORMS_SECTION: &str = "surfaceForms";

/// Returns the bytes of every section that [`read_resident`] reads whole into memory.
pub(super) fn resident_bytes(head: &PagedHead) -> u64 {
    head.sections
        .iter()
        .filter(|section| {
            let name = section.name.as_str();
            RESIDENT_TABLES.contains(&name)
                || RESIDENT_LISTS.contains(&name)
                || name == SURFACE_FORMS_SECTION
        })
        .fold(0u64, |total, section| total.saturating_add(section.length))
}

/// The resident sections of a paged segment once read and checked.
pub(super) struct Resident {
    pub(super) segment: KeywordSegment,
    pub(super) document_blocks: Vec<BlockEntry>,
    pub(super) id_sample: Vec<(String, u32)>,
}

fn checked_u32s(file: &PagedFile, head: &PagedHead, name: &str, key: &str) -> Result<Vec<u32>> {
    let section = required(head, name, key)?;
    if section.length % 4 != 0 {
        return load_failed(format!(
            "Section \"{name}\" of \"{}\" is not a whole number of values",
            file.path().display()
        ));
    }
    let bytes = file.whole_checked(&section)?;
    Ok((0..bytes.len() / 4)
        .map(|at| le_u32(&bytes, at * 4))
        .collect())
}

fn resident_list(file: &PagedFile, head: &PagedHead, name: &str, key: &str) -> Result<Value> {
    let section = required(head, name, key)?;
    let bytes = file.whole_checked(&section)?;
    decode_value(&bytes).or_else(|error| {
        load_failed(format!(
            "Section \"{name}\" of \"{}\" is not MessagePack: {}",
            file.path().display(),
            error.message()
        ))
    })
}

fn require_blocks(
    lists: &[u32],
    offsets: &[u32],
    summaries: &[u8],
    posting_offsets: &[u32],
    key: &str,
    fields: &Fields<'_>,
) -> Result<()> {
    if !summaries.len().is_multiple_of(BLOCK_SUMMARY_BYTES) {
        return load_failed(format!("The block summaries of \"{key}\" are cut short"));
    }
    if offsets.len() != lists.len() + 1 {
        return load_failed(format!(
            "The block list offsets of \"{key}\" have the wrong length"
        ));
    }
    require_offsets(
        fields,
        offsets,
        summaries.len() / BLOCK_SUMMARY_BYTES,
        "blockListOffsets",
    )?;
    let token_count = posting_offsets.len().saturating_sub(1);
    for (at, &token) in lists.iter().enumerate() {
        if at > 0 && token <= lists[at - 1] {
            return load_failed(format!(
                "blockLists of \"{key}\" fails to ascend at entry {at}"
            ));
        }
        if token as usize >= token_count {
            return load_failed(format!(
                "blockLists of \"{key}\" holds token {token} of {token_count}"
            ));
        }
        let length = posting_offsets[token as usize + 1] - posting_offsets[token as usize];
        if length as usize <= SMALLEST_BLOCK_POSTINGS {
            return load_failed(format!(
                "blockLists of \"{key}\" lists token {token}, which holds too few postings"
            ));
        }
        let mut before = 0u32;
        for block in offsets[at]..offsets[at + 1] {
            let end = le_u32(summaries, block as usize * BLOCK_SUMMARY_BYTES);
            let place = block - offsets[at];
            if end <= before || end > length {
                return load_failed(format!(
                    "Block {place} of token {token} of \"{key}\" ends outside its list"
                ));
            }
            before = end;
        }
        if before != length {
            return load_failed(format!(
                "The blocks of token {token} of \"{key}\" fail to cover its list"
            ));
        }
    }
    Ok(())
}

fn document_blocks(
    bytes: &[u8],
    document_count: u32,
    section_length: u64,
    key: &str,
) -> Result<Vec<BlockEntry>> {
    if !bytes.len().is_multiple_of(DOCUMENT_BLOCK_BYTES) {
        return load_failed(format!("The document blocks of \"{key}\" are cut short"));
    }
    let mut blocks = Vec::with_capacity(bytes.len() / DOCUMENT_BLOCK_BYTES);
    let mut previous_end = 0u64;
    for (at, raw) in bytes
        .as_chunks::<DOCUMENT_BLOCK_BYTES>()
        .0
        .iter()
        .enumerate()
    {
        let mut offset = [0u8; 8];
        offset.copy_from_slice(&raw[4..12]);
        let block = BlockEntry {
            first_ordinal: le_u32(raw, 0),
            offset: u64::from_le_bytes(offset),
            length: le_u32(raw, 12),
            raw_length: le_u32(raw, 16),
        };
        let starts_wrongly = blocks
            .last()
            .is_some_and(|before: &BlockEntry| block.first_ordinal <= before.first_ordinal);
        if starts_wrongly || block.first_ordinal >= document_count {
            return load_failed(format!("Document block {at} of \"{key}\" starts wrongly"));
        }
        let end = block.offset.saturating_add(u64::from(block.length));
        if block.offset != previous_end || end > section_length {
            return load_failed(format!(
                "Document block {at} of \"{key}\" lies outside its section"
            ));
        }
        if block.raw_length > MAX_DOCUMENT_BLOCK_RAW_BYTES {
            return load_failed(format!(
                "Document block {at} of \"{key}\" claims {} bytes",
                block.raw_length
            ));
        }
        previous_end = end;
        blocks.push(block);
    }
    if document_count > 0 && blocks.first().is_none_or(|block| block.first_ordinal != 0) {
        return load_failed(format!(
            "The document blocks of \"{key}\" fail to cover its documents"
        ));
    }
    Ok(blocks)
}

fn id_sample(value: &Value, path: &str) -> Result<Vec<(String, u32)>> {
    let Value::Array(entries) = value else {
        return load_failed(format!("Section \"idSample\" of \"{path}\" is not a list"));
    };
    let mut sample: Vec<(String, u32)> = Vec::with_capacity(entries.len());
    for (at, entry) in entries.iter().enumerate() {
        let pair = match entry {
            Value::Array(pair) => match pair.as_slice() {
                [Value::String(id), Value::Number(position), ..] => Some((id, *position)),
                _ => None,
            },
            _ => None,
        };
        let Some((id, position)) = pair else {
            return load_failed(format!(
                "Section \"idSample\" of \"{path}\" holds an invalid entry at {at}"
            ));
        };
        let position = position as u32;
        if sample.last().is_some_and(|(_, before)| position <= *before) {
            return load_failed(format!(
                "Section \"idSample\" of \"{path}\" fails to ascend at entry {at}"
            ));
        }
        sample.push((id.clone(), position));
    }
    Ok(sample)
}

/// Reads every resident section of a paged segment whole, checks each of its pages, and applies to each one the
/// rules of the keyword segment payload.
pub(super) fn read_resident(file: &PagedFile, head: &PagedHead, key: &str) -> Result<Resident> {
    let empty = Map::new();
    let fields = Fields::new(&empty, ErrorCode::PERSISTENCE_LOAD_FAILED, ERROR_PREFIX);
    require_valid_field_types(&head.schema)?;
    if head.field_names.len() > MAX_SEGMENT_FIELD_NAMES {
        return load_failed(format!(
            "{ERROR_PREFIX}fieldNames holds {} names, above the limit of {MAX_SEGMENT_FIELD_NAMES}",
            head.field_names.len()
        ));
    }
    let count = head.document_count;
    let tokens = file.whole_checked(&required(head, "tokens", key)?)?;
    let token_offsets = checked_u32s(file, head, "tokenOffsets", key)?;
    require_offsets(&fields, &token_offsets, tokens.len(), "tokenOffsets")?;
    require_utf8_entries(&fields, &tokens, &token_offsets, "tokens")?;
    require_entries_ascend(&fields, &tokens, &token_offsets, None, "tokens")?;
    let token_count = token_offsets.len() - 1;
    let document_frequencies = checked_u32s(file, head, "documentFrequencies", key)?;
    let posting_offsets = checked_u32s(file, head, "postingOffsets", key)?;
    if document_frequencies.len() != token_count || posting_offsets.len() != token_count + 1 {
        return load_failed(format!(
            "The token columns of \"{key}\" disagree on the token count"
        ));
    }
    let posting_bytes = required(head, "postings", key)?.length;
    if posting_bytes % POSTING_WIDTH_BYTES != 0 {
        return load_failed(format!(
            "{ERROR_PREFIX}postingOffsets ends where the postings hold part of a posting"
        ));
    }
    require_offsets(
        &fields,
        &posting_offsets,
        (posting_bytes / POSTING_WIDTH_BYTES) as usize,
        "postingOffsets",
    )?;
    for (token, &frequency) in document_frequencies.iter().enumerate() {
        let postings = posting_offsets[token + 1] - posting_offsets[token];
        if frequency == 0 || frequency > postings {
            return load_failed(format!(
                "documentFrequencies of \"{key}\" gives token {token} a count of {frequency}"
            ));
        }
    }
    let block_lists = checked_u32s(file, head, "blockLists", key)?;
    let block_list_offsets = checked_u32s(file, head, "blockListOffsets", key)?;
    let summaries = file.whole_checked(&required(head, "blockSummaries", key)?)?;
    require_blocks(
        &block_lists,
        &block_list_offsets,
        &summaries,
        &posting_offsets,
        key,
        &fields,
    )?;
    let documents_length = required(head, "documents", key)?.length;
    let block_bytes = file.whole_checked(&required(head, "documentBlocks", key)?)?;
    let document_blocks = document_blocks(&block_bytes, count, documents_length, key)?;
    let path = file.path().display().to_string();
    let id_sample = id_sample(&resident_list(file, head, "idSample", key)?, &path)?;
    let mut lists = Map::new();
    for name in RESIDENT_LISTS {
        lists.insert(name, resident_list(file, head, name, key)?);
    }
    if let Some(section) = head.section(SURFACE_FORMS_SECTION) {
        let bytes = file.whole_checked(section)?;
        let value = decode_value(&bytes).or_else(|error| {
            load_failed(format!(
                "Section \"surfaceForms\" of \"{key}\" is not MessagePack: {}",
                error.message()
            ))
        })?;
        lists.insert("surfaceForms", value);
    }
    let columns = Fields::new(&lists, ErrorCode::PERSISTENCE_LOAD_FAILED, ERROR_PREFIX);
    let mut segment = KeywordSegment {
        schema: head.schema.clone(),
        tombstones: head.tombstones.clone(),
        document_count: count,
        field_names: head.field_names.clone(),
        tokens,
        token_offsets,
        document_frequencies,
        posting_offsets,
        ..KeywordSegment::default()
    };
    segment.decode_columns(&columns, count, token_count)?;
    Ok(Resident {
        segment,
        document_blocks,
        id_sample,
    })
}
