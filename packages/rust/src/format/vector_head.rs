use crate::error::{ErrorCode, NarsilError, Result, load_failed};
use crate::format::file_sections::{RECORD_PAGE_BYTES, SEGMENT_PAGE_BYTES};
use crate::format::manifest_refs::FileRef;
use crate::format::paged_segment::head::{PagedSection, decode_sections};
use crate::util::hash::crc32;
use crate::value::{Map, Value, decode_value};

const FLOAT64_BYTES: u64 = 8;
const UINT32_BYTES: usize = 4;
const VECTOR_FILE_SECTIONS: [&str; 4] = ["docIds", "idOffsets", "idOrder", "vectors"];

fn head_of<'a>(payload: &'a [u8], file: &FileRef) -> Result<Option<&'a [u8]>> {
    let Some(head) = &file.head else {
        return Ok(None);
    };
    let key = &file.key;
    let bytes = usize::try_from(head.offset).ok().and_then(|start| {
        let end = start.checked_add(usize::try_from(head.length).ok()?)?;
        payload.get(start..end)
    });
    let Some(bytes) = bytes else {
        return load_failed(format!(
            "The head of the file \"{key}\" ends outside its payload"
        ));
    };
    if crc32(bytes) != head.checksum {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_CRC_MISMATCH,
            format!("The head of the file \"{key}\" does not match its checksum"),
        ));
    }
    Ok(Some(bytes))
}

fn decoded_head(head: &[u8], key: &str) -> Result<Map> {
    let raw = decode_value(head).map_err(|error| {
        NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!(
                "The head of \"{key}\" is not MessagePack: {}",
                error.message()
            ),
        )
    })?;
    match raw {
        Value::Object(map) => Ok(map),
        _ => load_failed(format!("The head of \"{key}\" is not a map")),
    }
}

fn check_pages(payload: &[u8], section: &PagedSection, key: &str) -> Result<()> {
    let end = section.offset.saturating_add(section.length);
    for page in 0..section.page_count() {
        let start = section
            .offset
            .saturating_add(page.saturating_mul(section.page_bytes));
        let stop = start.saturating_add(section.page_bytes).min(end);
        let bytes = usize::try_from(start)
            .ok()
            .zip(usize::try_from(stop).ok())
            .and_then(|(start, stop)| payload.get(start..stop));
        let Some(bytes) = bytes else {
            return load_failed(format!(
                "Section \"{}\" of the file \"{key}\" ends outside its payload",
                section.name
            ));
        };
        if section.checksum_of_page(page) != Some(crc32(bytes)) {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_CRC_MISMATCH,
                format!(
                    "Page {page} of section \"{}\" of the file \"{key}\" does not match its checksum",
                    section.name
                ),
            ));
        }
    }
    Ok(())
}

fn required<'a>(sections: &'a [PagedSection], name: &str, key: &str) -> Result<&'a PagedSection> {
    match sections.iter().find(|section| section.name == name) {
        Some(section) => Ok(section),
        None => load_failed(format!("The head of \"{key}\" lists no section \"{name}\"")),
    }
}

/// Checks the head that the manifest lists for a vector file of a field whose vectors stay on disk, holding
/// `count` vectors: the head's CRC-32 against the manifest, its sections against the payload, and the CRC-32 of
/// every page of every section, so that a damaged file refuses the open as it would refuse a read by position.
pub(crate) fn check_vector_file_head(payload: &[u8], file: &FileRef, count: u32) -> Result<()> {
    let key = file.key.as_str();
    let Some(head) = head_of(payload, file)? else {
        return Ok(());
    };
    let raw = decoded_head(head, key)?;
    let sections = decode_sections(
        raw.get("sections"),
        payload.len() as u64,
        &format!("head of \"{key}\""),
        &[SEGMENT_PAGE_BYTES as u64, RECORD_PAGE_BYTES as u64],
    )?;
    let magnitudes = required(&sections, "magnitudes", key)?;
    if magnitudes.length != u64::from(count) * FLOAT64_BYTES {
        let held = Value::Number(magnitudes.length as f64 / FLOAT64_BYTES as f64).to_json();
        return load_failed(format!("The file \"{key}\" holds {held} magnitudes"));
    }
    for name in VECTOR_FILE_SECTIONS {
        required(&sections, name, key)?;
    }
    for section in &sections {
        check_pages(payload, section, key)?;
    }
    Ok(())
}

fn one_section(
    layout: &Map,
    name: &str,
    key: &str,
    payload_length: u64,
    page_bytes: usize,
) -> Result<PagedSection> {
    let listed = Value::Array(vec![layout.get(name).cloned().unwrap_or_default()]);
    let mut sections = decode_sections(
        Some(&listed),
        payload_length,
        &format!("head of \"{key}\""),
        &[page_bytes as u64],
    )?;
    match sections.pop() {
        Some(section) => Ok(section),
        None => load_failed(format!("The head of \"{key}\" lists no section \"{name}\"")),
    }
}

fn node_offsets(
    layout: &Map,
    levels: &PagedSection,
    neighbours: &PagedSection,
    key: &str,
) -> Result<()> {
    let Some(Value::Bytes(bytes)) = layout.get("nodeOffsets") else {
        return load_failed(format!("The head of \"{key}\" holds no node offsets"));
    };
    let count = bytes.len() / UINT32_BYTES;
    if bytes.len() % UINT32_BYTES != 0 || count as u64 != levels.length.saturating_add(1) {
        return load_failed(format!(
            "The head of \"{key}\" holds the wrong number of offsets"
        ));
    }
    let offsets: Vec<u32> = bytes
        .chunks_exact(UINT32_BYTES)
        .map(|value| u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
        .collect();
    if offsets.windows(2).any(|pair| pair[1] < pair[0]) {
        return load_failed(format!(
            "The head of \"{key}\" holds descending node offsets"
        ));
    }
    if offsets
        .last()
        .is_some_and(|&last| u64::from(last) > neighbours.length)
    {
        return load_failed(format!(
            "The node offsets of \"{key}\" end outside its neighbour lists"
        ));
    }
    Ok(())
}

/// Checks the head that the manifest lists for a graph part of a field whose vectors stay on disk: the head's
/// CRC-32 against the manifest, its level and neighbour sections against the payload, its node offsets against
/// those sections, and the CRC-32 of every page of both sections.
pub(crate) fn check_graph_part_head(payload: &[u8], file: &FileRef) -> Result<()> {
    let key = file.key.as_str();
    let Some(head) = head_of(payload, file)? else {
        return Ok(());
    };
    let raw = decoded_head(head, key)?;
    let Some(Value::Array(graphs)) = raw.get("graphs") else {
        return Ok(());
    };
    let [graph] = graphs.as_slice() else {
        return Ok(());
    };
    let empty = Map::new();
    let layout = match graph {
        Value::Object(layout) => layout,
        _ => &empty,
    };
    let payload_length = payload.len() as u64;
    let levels = one_section(layout, "levels", key, payload_length, SEGMENT_PAGE_BYTES)?;
    let neighbours = one_section(layout, "neighbours", key, payload_length, RECORD_PAGE_BYTES)?;
    node_offsets(layout, &levels, &neighbours, key)?;
    if !matches!(layout.get("maxLayer"), Some(Value::Number(_)))
        || !matches!(layout.get("m"), Some(Value::Number(_)))
    {
        return load_failed(format!("The head of \"{key}\" holds no layers"));
    }
    if !matches!(
        layout.get("entryPoint"),
        Some(Value::Number(_)) | Some(Value::Null)
    ) {
        return load_failed(format!("The head of \"{key}\" holds no entry"));
    }
    check_pages(payload, &levels, key)?;
    check_pages(payload, &neighbours, key)
}
