use crate::error::{ErrorCode, NarsilError, Result, load_failed};
use crate::format::envelope::HEADER_BYTES;
use crate::format::file_sections::{RECORD_PAGE_BYTES, SEGMENT_PAGE_BYTES, binary_header_bytes};
use crate::format::manifest_refs::FileRef;
use crate::format::paged_segment::head::{PagedSection, decode_sections};
use crate::util::bytes::le_values;
use crate::util::hash::crc32;
use crate::value::{Map, Value, decode_value};

const FLOAT64_BYTES: u64 = 8;
const UINT32_BYTES: usize = 4;
const CODES_KEY_AND_MAP_HEADER_BYTES: usize = 7;
const CODE_VALUES_BEFORE_RECORDS: usize = 5;
const FIXARRAY_OF_CODE_VALUES: u8 = 0x90 | CODE_VALUES_BEFORE_RECORDS as u8;
const MAX_CENTROID_BYTES_PER_COMPONENT: u64 = 9;
const MAX_CODE_BYTES_BESIDE_CENTROID: u64 = 64;

pub(crate) struct VectorFileSections {
    pub(crate) doc_ids: PagedSection,
    pub(crate) id_offsets: PagedSection,
    pub(crate) id_order: PagedSection,
    pub(crate) magnitudes: PagedSection,
    pub(crate) vectors: PagedSection,
    pub(crate) records: Option<PagedSection>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FileCodes {
    pub(crate) bits: u8,
    pub(crate) centroid: Vec<f32>,
}

pub(crate) struct CodesSpan {
    pub(crate) offset: u64,
    pub(crate) length: usize,
}

pub(crate) struct GraphPartLayout {
    pub(crate) entry_point: Option<f64>,
    pub(crate) max_layer: f64,
    pub(crate) levels: PagedSection,
    pub(crate) node_offsets: Vec<u32>,
    pub(crate) neighbours: PagedSection,
}

pub(crate) fn payload_length_of(file: &FileRef) -> u64 {
    file.bytes.saturating_sub(HEADER_BYTES as u64)
}

pub(crate) fn require_head_checksum(head: &[u8], file: &FileRef) -> Result<()> {
    if file
        .head
        .is_some_and(|listed| listed.checksum == crc32(head))
    {
        return Ok(());
    }
    Err(NarsilError::new(
        ErrorCode::PERSISTENCE_CRC_MISMATCH,
        format!(
            "The head of the file \"{}\" does not match its checksum",
            file.key
        ),
    ))
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

pub(crate) fn decode_vector_file_head(head: &[u8], file: &FileRef) -> Result<Vec<PagedSection>> {
    let key = file.key.as_str();
    let raw = decoded_head(head, key)?;
    decode_sections(
        raw.get("sections"),
        payload_length_of(file),
        &format!("head of \"{key}\""),
        &[SEGMENT_PAGE_BYTES as u64, RECORD_PAGE_BYTES as u64],
    )
}

fn listed<'a>(sections: &'a [PagedSection], name: &str) -> Option<&'a PagedSection> {
    sections.iter().find(|section| section.name == name)
}

fn required(sections: &[PagedSection], name: &str, key: &str) -> Result<PagedSection> {
    match listed(sections, name) {
        Some(section) => Ok(section.clone()),
        None => load_failed(format!("The head of \"{key}\" lists no section \"{name}\"")),
    }
}

pub(crate) fn codes_span(
    sections: &[PagedSection],
    dimension: usize,
    key: &str,
) -> Result<Option<CodesSpan>> {
    let (Some(records), Some(doc_ids)) = (listed(sections, "records"), listed(sections, "docIds"))
    else {
        return Ok(None);
    };
    let offset = doc_ids.offset.saturating_add(doc_ids.length);
    let record_header = usize::try_from(records.length).map_or(5, binary_header_bytes) as u64;
    let length = records
        .offset
        .checked_sub(offset)
        .and_then(|between| between.checked_sub(record_header))
        .filter(|&length| length > CODES_KEY_AND_MAP_HEADER_BYTES as u64);
    let Some(length) = length else {
        return load_failed(format!(
            "The file \"{key}\" places its codes before its IDs"
        ));
    };
    let most = (dimension as u64)
        .saturating_mul(MAX_CENTROID_BYTES_PER_COMPONENT)
        .saturating_add(MAX_CODE_BYTES_BESIDE_CENTROID);
    if length > most {
        return load_failed(format!(
            "The file \"{key}\" holds its codes in another layout"
        ));
    }
    Ok(Some(CodesSpan {
        offset,
        length: length as usize,
    }))
}

pub(crate) fn decode_file_codes(span: &[u8], key: &str) -> Result<FileCodes> {
    let mut listed = Vec::with_capacity(span.len());
    listed.push(FIXARRAY_OF_CODE_VALUES);
    listed.extend_from_slice(
        span.get(CODES_KEY_AND_MAP_HEADER_BYTES..)
            .unwrap_or_default(),
    );
    let values = match decode_value(&listed) {
        Ok(Value::Array(values)) => values,
        Ok(_) => Vec::new(),
        Err(error) => {
            return load_failed(format!(
                "The codes of \"{key}\" are not MessagePack: {}",
                error.message()
            ));
        }
    };
    let (
        Some(Value::String(bits_key)),
        Some(bits),
        Some(Value::String(centroid_key)),
        Some(Value::Array(centroid)),
    ) = (values.first(), values.get(1), values.get(2), values.get(3))
    else {
        return load_failed(format!(
            "The file \"{key}\" holds its codes in another layout"
        ));
    };
    if bits_key != "bits" || centroid_key != "centroid" {
        return load_failed(format!(
            "The file \"{key}\" holds its codes in another layout"
        ));
    }
    let bits = match bits {
        Value::Number(number) if [1.0, 2.0, 4.0, 8.0].contains(number) => *number as u8,
        other => {
            return load_failed(format!(
                "The file \"{key}\" holds {} bit codes",
                other.to_json()
            ));
        }
    };
    let centroid = centroid
        .iter()
        .map(|component| match component {
            Value::Number(number) if number.is_finite() && (*number as f32).is_finite() => {
                Ok(*number as f32)
            }
            _ => load_failed(format!(
                "The centroid of \"{key}\" holds an invalid float32 value"
            )),
        })
        .collect::<Result<Vec<f32>>>()?;
    Ok(FileCodes { bits, centroid })
}

pub(crate) fn vector_file_sections(
    sections: &[PagedSection],
    key: &str,
    count: u32,
) -> Result<VectorFileSections> {
    let magnitudes = required(sections, "magnitudes", key)?;
    if magnitudes.length != u64::from(count) * FLOAT64_BYTES {
        let held = Value::Number(magnitudes.length as f64 / FLOAT64_BYTES as f64).to_json();
        return load_failed(format!("The file \"{key}\" holds {held} magnitudes"));
    }
    Ok(VectorFileSections {
        doc_ids: required(sections, "docIds", key)?,
        id_offsets: required(sections, "idOffsets", key)?,
        id_order: required(sections, "idOrder", key)?,
        vectors: required(sections, "vectors", key)?,
        records: listed(sections, "records").cloned(),
        magnitudes,
    })
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
) -> Result<Vec<u32>> {
    let Some(Value::Bytes(bytes)) = layout.get("nodeOffsets") else {
        return load_failed(format!("The head of \"{key}\" holds no node offsets"));
    };
    if bytes.len() % UINT32_BYTES != 0 {
        return load_failed("The node offsets do not hold whole uint32 values");
    }
    let count = bytes.len() / UINT32_BYTES;
    if count as u64 != levels.length.saturating_add(1) {
        return load_failed(format!(
            "The head of \"{key}\" holds the wrong number of offsets"
        ));
    }
    let offsets: Vec<u32> = le_values(bytes, u32::from_le_bytes).collect();
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
    Ok(offsets)
}

pub(crate) fn decode_graph_part_head(
    head: &[u8],
    file: &FileRef,
) -> Result<Option<GraphPartLayout>> {
    let key = file.key.as_str();
    let raw = decoded_head(head, key)?;
    let Some(Value::Array(graphs)) = raw.get("graphs") else {
        return Ok(None);
    };
    let [graph] = graphs.as_slice() else {
        return Ok(None);
    };
    let empty = Map::new();
    let layout = match graph {
        Value::Object(layout) => layout,
        _ => &empty,
    };
    let payload_length = payload_length_of(file);
    let levels = one_section(layout, "levels", key, payload_length, SEGMENT_PAGE_BYTES)?;
    let neighbours = one_section(layout, "neighbours", key, payload_length, RECORD_PAGE_BYTES)?;
    let node_offsets = node_offsets(layout, &levels, &neighbours, key)?;
    let (Some(Value::Number(max_layer)), Some(Value::Number(_))) =
        (layout.get("maxLayer"), layout.get("m"))
    else {
        return load_failed(format!("The head of \"{key}\" holds no layers"));
    };
    let entry_point = match layout.get("entryPoint") {
        Some(Value::Number(entry)) => Some(*entry),
        Some(Value::Null) => None,
        _ => return load_failed(format!("The head of \"{key}\" holds no entry")),
    };
    Ok(Some(GraphPartLayout {
        entry_point,
        max_layer: *max_layer,
        levels,
        node_offsets,
        neighbours,
    }))
}
