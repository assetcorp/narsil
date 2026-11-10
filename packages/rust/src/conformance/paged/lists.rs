use std::io::Read;

use flate2::read::DeflateDecoder;

use super::WHAT;
use super::sections::Sections;
use crate::conformance::forms::{form_error, numbers_form};
use crate::error::Result;
use crate::format::paged_segment::{
    BLOCK_SUMMARY_BYTES, DOCUMENT_BLOCK_BYTES, MAX_DOCUMENT_BLOCK_RAW_BYTES, POSTING_WIDTH_BYTES,
};
use crate::util::bytes::{le_u32 as u32_at, le_values, u32_list};
use crate::value::{Decoder, Map, Value};

/// Returns the JSON form of the `blockSummaries` section: one entry per posting block.
pub(super) fn block_summaries_form(bytes: &[u8]) -> Result<Value> {
    if !bytes.len().is_multiple_of(BLOCK_SUMMARY_BYTES) {
        return Err(form_error(format!(
            "the {WHAT} holds a partial block summary"
        )));
    }
    let summaries = bytes
        .as_chunks::<BLOCK_SUMMARY_BYTES>()
        .0
        .iter()
        .map(|record| {
            let mut length = [0u8; 8];
            length.copy_from_slice(&record[6..14]);
            let mut summary = Map::new();
            summary.insert("postingEnd", Value::Number(f64::from(u32_at(record, 0))));
            summary.insert(
                "maxTermFrequency",
                Value::Number(f64::from(u16::from_le_bytes([record[4], record[5]]))),
            );
            summary.insert("minFieldLength", Value::Number(f64::from_le_bytes(length)));
            summary.insert(
                "maxEntriesPerDocument",
                Value::Number(f64::from(u32_at(record, 14))),
            );
            summary.insert(
                "documentCount",
                Value::Number(f64::from(u32_at(record, 18))),
            );
            Value::Object(summary)
        })
        .collect();
    Ok(Value::Array(summaries))
}

fn u16s(bytes: &[u8]) -> impl Iterator<Item = u16> + '_ {
    le_values(bytes, u16::from_le_bytes)
}

/// Puts the postings of every token into `forms` as the `postingDocuments`, `postingFrequencies`, and
/// `postingFields` lists of a keyword segment payload.
pub(super) fn posting_forms(sections: &Sections<'_>, forms: &mut Map) -> Result<()> {
    let offsets = sections.u32s("postingOffsets")?;
    let postings = sections.named("postings")?;
    let width = POSTING_WIDTH_BYTES as usize;
    let total = postings.len() / width;
    let mut documents = Vec::with_capacity(total);
    let mut frequencies = Vec::with_capacity(total);
    let mut fields = Vec::with_capacity(total);
    for pair in offsets.windows(2) {
        let count = pair[1].checked_sub(pair[0]).ok_or_else(|| {
            form_error(format!(
                "the {WHAT} gives a token postings that run backwards"
            ))
        })? as usize;
        let list = (pair[0] as usize)
            .checked_mul(width)
            .zip(count.checked_mul(width))
            .and_then(|(start, bytes)| postings.get(start..start.checked_add(bytes)?))
            .ok_or_else(|| {
                form_error(format!(
                    "the {WHAT} gives a token postings outside the postings section"
                ))
            })?;
        let (ordinals, rest) = list.split_at(count * 4);
        let (counts, field_numbers) = rest.split_at(count * 2);
        documents.extend(u32_list(ordinals, "postings")?);
        frequencies.extend(u16s(counts));
        fields.extend(u16s(field_numbers));
    }
    forms.insert("postingDocuments", numbers_form(&documents));
    forms.insert("postingFrequencies", numbers_form(&frequencies));
    forms.insert("postingFields", numbers_form(&fields));
    Ok(())
}

fn inflated(compressed: &[u8], raw_length: u32, block: usize) -> Result<Vec<u8>> {
    let limit = u64::from(MAX_DOCUMENT_BLOCK_RAW_BYTES) + 1;
    let mut raw = Vec::with_capacity(raw_length as usize);
    DeflateDecoder::new(compressed)
        .take(limit)
        .read_to_end(&mut raw)
        .map_err(|error| form_error(format!("document block {block} fails to inflate: {error}")))?;
    if raw.len() != raw_length as usize {
        return Err(form_error(format!(
            "document block {block} inflates to {} bytes",
            raw.len()
        )));
    }
    Ok(raw)
}

/// Returns every stored document of a paged segment, in ordinal order, from its compressed document blocks.
pub(super) fn documents_form(sections: &Sections<'_>) -> Result<Value> {
    let blocks = sections.named("documentBlocks")?;
    let compressed = sections.named("documents")?;
    if !blocks.len().is_multiple_of(DOCUMENT_BLOCK_BYTES) {
        return Err(form_error(format!(
            "the {WHAT} holds a partial document block"
        )));
    }
    let count = sections.head.document_count as usize;
    let (records, _) = blocks.as_chunks::<DOCUMENT_BLOCK_BYTES>();
    let mut documents = Vec::with_capacity(count);
    for (block, record) in records.iter().enumerate() {
        let first = u32_at(record, 0) as usize;
        let mut offset = [0u8; 8];
        offset.copy_from_slice(&record[4..12]);
        let offset = usize::try_from(u64::from_le_bytes(offset)).unwrap_or(usize::MAX);
        let length = u32_at(record, 12) as usize;
        let raw_length = u32_at(record, 16);
        let end = records
            .get(block + 1)
            .map_or(count, |next| u32_at(next, 0) as usize);
        if first != documents.len() || end < first || raw_length > MAX_DOCUMENT_BLOCK_RAW_BYTES {
            return Err(form_error(format!(
                "the {WHAT} gives document block {block} a placement outside its limits"
            )));
        }
        let bytes = offset
            .checked_add(length)
            .and_then(|stop| compressed.get(offset..stop))
            .ok_or_else(|| {
                form_error(format!(
                    "the {WHAT} ends document block {block} outside its section"
                ))
            })?;
        let raw = inflated(bytes, raw_length, block)?;
        let mut decoder = Decoder::new(&raw);
        while !decoder.is_finished() {
            if documents.len() >= end {
                return Err(form_error(format!(
                    "document block {block} holds more documents than its placement gives"
                )));
            }
            documents.push(decoder.read_value(1)?);
        }
        if documents.len() != end {
            return Err(form_error(format!(
                "document block {block} holds fewer documents than its placement gives"
            )));
        }
    }
    if documents.len() != count {
        return Err(form_error(format!(
            "the {WHAT} blocks hold {} documents",
            documents.len()
        )));
    }
    Ok(Value::Array(documents))
}
