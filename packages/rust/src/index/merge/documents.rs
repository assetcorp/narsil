use std::collections::HashSet;

use super::inputs::{MergeInput, as_u32, damaged};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::segment::SegmentData;
use crate::util::bytes::offset_entry;
use crate::value::{Map, Value, decode_document, encode_document};

/// The IDs and stored documents of a merged segment, in ordinal order, with the ordinals in ascending ID order.
pub(crate) struct DocumentTable {
    pub(crate) ids: Vec<u8>,
    pub(crate) id_offsets: Vec<u32>,
    pub(crate) id_order: Vec<u32>,
    pub(crate) documents: Vec<u8>,
    pub(crate) document_offsets: Vec<u32>,
}

fn remove_path(document: &mut Map, path: &str) -> bool {
    match path.split_once('.') {
        None => document.remove(path).is_some(),
        Some((first, rest)) => match document.get_mut(first) {
            Some(Value::Object(nested)) => remove_path(nested, rest),
            _ => false,
        },
    }
}

fn holds_path(document: &Map, path: &str) -> bool {
    match path.split_once('.') {
        None => document.contains_key(path),
        Some((first, rest)) => match document.get(first) {
            Some(Value::Object(nested)) => holds_path(nested, rest),
            _ => false,
        },
    }
}

fn without_vectors(document: &Map, vector_paths: &HashSet<String>) -> Option<Map> {
    if !vector_paths.iter().any(|path| holds_path(document, path)) {
        return None;
    }
    let mut stripped = document.clone();
    for path in vector_paths {
        remove_path(&mut stripped, path);
    }
    Some(stripped)
}

fn encoded(document: &Map, vector_paths: &HashSet<String>) -> Result<Vec<u8>> {
    match without_vectors(document, vector_paths) {
        Some(stripped) => encode_document(&stripped),
        None => encode_document(document),
    }
}

pub(super) fn append_document(
    input: &MergeInput<'_>,
    ordinal: u32,
    vector_paths: &HashSet<String>,
    out: &mut Vec<u8>,
) -> Result<()> {
    match &input.entry.data {
        SegmentData::Tail(tail) => {
            let document = tail
                .documents
                .get(ordinal as usize)
                .ok_or_else(|| damaged("holds an ordinal without a document"))?;
            out.extend_from_slice(&encoded(document, vector_paths)?);
        }
        SegmentData::Frozen(segment) => {
            let bytes = segment.document_bytes(ordinal)?;
            if vector_paths.is_empty() {
                out.extend_from_slice(&bytes);
                return Ok(());
            }
            let document = decode_document(&bytes)?;
            match without_vectors(&document, vector_paths) {
                Some(stripped) => out.extend_from_slice(&encode_document(&stripped)?),
                None => out.extend_from_slice(&bytes),
            }
        }
    }
    Ok(())
}

/// Copies the IDs and documents that the inputs keep, removing every vector value that the schema declares, and
/// raises `PARTITION_CORRUPTED` where two kept documents share an ID.
pub(crate) fn merge_documents(
    inputs: &[MergeInput<'_>],
    document_count: u32,
    vector_paths: &HashSet<String>,
) -> Result<DocumentTable> {
    let count = document_count as usize;
    let mut table = DocumentTable {
        ids: Vec::new(),
        id_offsets: Vec::with_capacity(count + 1),
        id_order: Vec::with_capacity(count),
        documents: Vec::new(),
        document_offsets: Vec::with_capacity(count + 1),
    };
    table.id_offsets.push(0);
    table.document_offsets.push(0);
    for input in inputs {
        for ordinal in input.entry.live_ordinals() {
            if input.target(ordinal).is_none() {
                continue;
            }
            table
                .ids
                .extend_from_slice(input.entry.id_of(ordinal)?.as_bytes());
            table.id_offsets.push(as_u32(table.ids.len(), "ID bytes")?);
            append_document(input, ordinal, vector_paths, &mut table.documents)?;
            table
                .document_offsets
                .push(as_u32(table.documents.len(), "document bytes")?);
        }
    }
    let id_of = |ordinal: u32| offset_entry(&table.ids, &table.id_offsets, ordinal as usize);
    let mut order: Vec<u32> = (0..document_count).collect();
    order.sort_unstable_by(|&left, &right| id_of(left).cmp(id_of(right)));
    if let Some(pair) = order
        .windows(2)
        .find(|pair| id_of(pair[0]) == id_of(pair[1]))
    {
        let id = String::from_utf8_lossy(id_of(pair[0]));
        return Err(NarsilError::new(
            ErrorCode::PARTITION_CORRUPTED,
            format!("The segments of the partition hold document \"{id}\" more than once"),
        ));
    }
    table.id_order = order;
    Ok(table)
}
