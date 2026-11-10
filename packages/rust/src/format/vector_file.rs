use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::fields::Fields;
use crate::format::file_sections::{
    FileSection, PayloadBuilder, RECORD_PAGE_BYTES, SEGMENT_PAGE_BYTES, binary_header_bytes,
    settled_head, string_entry_bytes, write_sections,
};
use crate::format::manifest_refs::Head;
use crate::util::bytes::{f32_bytes, f32_list, f64_bytes, f64_list, u32_bytes, u32_list};
use crate::value::{
    Value, decode_value, write_array_header, write_binary, write_json, write_map_header, write_nil,
    write_number, write_string, write_uint,
};

pub(crate) const VECTOR_FILE_PAYLOAD_VERSION: u8 = 1;
pub(crate) const VECTOR_FILE_ENVELOPE_VERSION: u8 = 2;
pub(crate) const VECTOR_FILE_MAX_VECTORS: usize = 65_536;
pub(crate) const OSQ_RECORD_TAIL_BYTES: usize = 16;
const MAX_DIMENSION: f64 = 65_535.0;
const MEMORY_KEYS: usize = 6;
const DISK_KEYS: usize = 10;
const CODES_KEYS: usize = 3;
const PREFIX: &str = "Invalid vector file payload: ";

/// The quantised codes of a vector file: the bit width, the centroid, and one record for every vector.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct VectorCodes {
    pub(crate) bits: u8,
    pub(crate) centroid: Vec<f64>,
    pub(crate) records: Vec<u8>,
}

/// The columns that a disk field adds to each vector file, so that a reader can search the file in place.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DiskColumns {
    pub(crate) magnitudes: Vec<f64>,
    pub(crate) id_order: Vec<u32>,
}

/// The decoded payload of one vector file.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct VectorFile {
    pub(crate) field_name: String,
    pub(crate) dimension: usize,
    pub(crate) doc_ids: Vec<String>,
    pub(crate) codes: Option<VectorCodes>,
    pub(crate) vectors: Vec<f32>,
    pub(crate) disk: Option<DiskColumns>,
}

pub(crate) fn osq_code_bytes(dimension: usize, bits: u8) -> usize {
    (dimension * bits as usize).div_ceil(8)
}

pub(crate) fn osq_record_bytes(dimension: usize, bits: u8) -> usize {
    osq_code_bytes(dimension, bits) + OSQ_RECORD_TAIL_BYTES
}

pub(crate) fn require_payload_version(
    payload: &str,
    found: Option<&Value>,
    expected: u8,
) -> Result<()> {
    if let Some(Value::Number(number)) = found
        && *number == f64::from(expected)
    {
        return Ok(());
    }
    let shown = match found {
        Some(Value::String(text)) => text.clone(),
        Some(other) => write_json(other),
        None => "undefined".to_string(),
    };
    Err(NarsilError::new(
        ErrorCode::ENVELOPE_VERSION_MISMATCH,
        format!(
            "This {payload} payload was written in layout {shown}, and this build reads layout {expected} alone"
        ),
    ))
}

fn decode_codes(
    fields: &Fields<'_>,
    dimension: usize,
    count: usize,
) -> Result<Option<VectorCodes>> {
    let Some(raw) = fields.raw("codes") else {
        return Ok(None);
    };
    if matches!(raw, Value::Null) {
        return Ok(None);
    }
    let codes = match raw {
        Value::Object(_) => fields.nested(raw, "codes")?,
        _ => return Err(fields.error("codes must be a map or nil")),
    };
    let bits = match codes.raw("bits") {
        Some(Value::Number(number)) if [1.0, 2.0, 4.0, 8.0].contains(number) => *number as u8,
        _ => return Err(fields.error("codes.bits must be 8, 4, 2, or 1")),
    };
    let centroid = match codes.raw("centroid") {
        Some(Value::Array(items)) if items.len() == dimension => items
            .iter()
            .map(|item| match item {
                Value::Number(number) => Ok(*number),
                _ => Err(fields.error("codes.centroid must hold one number per dimension")),
            })
            .collect::<Result<Vec<f64>>>()?,
        _ => return Err(fields.error("codes.centroid must hold one number per dimension")),
    };
    let records = match codes.raw("records") {
        Some(Value::Bytes(bytes)) => bytes.clone(),
        _ => return Err(fields.error("codes.records must be bytes")),
    };
    if Some(records.len()) != count.checked_mul(osq_record_bytes(dimension, bits)) {
        return Err(fields.error("codes.records must hold one record per vector"));
    }
    Ok(Some(VectorCodes {
        bits,
        centroid,
        records,
    }))
}

fn decode_disk_columns(fields: &Fields<'_>, count: usize) -> Result<Option<DiskColumns>> {
    if !fields.has_key("magnitudes") && !fields.has_key("idOrder") {
        return Ok(None);
    }
    let magnitudes = f64_list(fields.bytes("magnitudes", 8)?, "magnitudes")?;
    let id_order = u32_list(fields.bytes("idOrder", 4)?, "idOrder")?;
    if magnitudes.len() != count || id_order.len() != count {
        return Err(fields.error("magnitudes and idOrder must hold one value per vector"));
    }
    let mut seen = vec![false; count];
    for &position in &id_order {
        match seen.get_mut(position as usize) {
            Some(slot) if !*slot => *slot = true,
            _ => return Err(fields.error("idOrder must list every vector once")),
        }
    }
    Ok(Some(DiskColumns {
        magnitudes,
        id_order,
    }))
}

/// Reads a vector file payload with the checks of the reference reader, in its order.
pub(crate) fn decode_vector_file(payload: &[u8]) -> Result<VectorFile> {
    let raw = decode_value(payload)?;
    let Value::Object(map) = &raw else {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!("{PREFIX}payload must be a map"),
        ));
    };
    let fields = Fields::new(map, ErrorCode::PERSISTENCE_LOAD_FAILED, PREFIX);
    require_payload_version("vector file", map.get("v"), VECTOR_FILE_PAYLOAD_VERSION)?;
    let field_name = fields.string("fieldName")?.to_string();
    let dimension = match map.get("dimension") {
        Some(Value::Number(number))
            if number.fract() == 0.0 && (1.0..=MAX_DIMENSION).contains(number) =>
        {
            *number as usize
        }
        _ => return Err(fields.error("dimension must be a positive uint16")),
    };
    let doc_ids = match map.get("docIds") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(text) => Ok(text.clone()),
                _ => Err(fields.error("docIds must be a list of strings")),
            })
            .collect::<Result<Vec<String>>>()?,
        _ => return Err(fields.error("docIds must be a list of strings")),
    };
    if doc_ids.len() > VECTOR_FILE_MAX_VECTORS {
        return Err(fields.error(format!(
            "a file holds at most {VECTOR_FILE_MAX_VECTORS} vectors"
        )));
    }
    let vector_bytes = match map.get("vectors") {
        Some(Value::Bytes(bytes)) => bytes,
        _ => return Err(fields.error("vectors must be bytes")),
    };
    if vector_bytes.len() != doc_ids.len() * dimension * 4 {
        return Err(fields.error("vectors must hold dimension float32 components per document"));
    }
    let codes = decode_codes(&fields, dimension, doc_ids.len())?;
    let disk = decode_disk_columns(&fields, doc_ids.len())?;
    let vectors = f32_list(vector_bytes, "vectors")?;
    Ok(VectorFile {
        field_name,
        dimension,
        doc_ids,
        codes,
        vectors,
        disk,
    })
}

fn write_codes(out: &mut Vec<u8>, codes: &VectorCodes) {
    write_map_header(out, CODES_KEYS);
    write_string(out, "bits");
    write_uint(out, u64::from(codes.bits));
    write_string(out, "centroid");
    write_array_header(out, codes.centroid.len());
    for &component in &codes.centroid {
        write_number(out, component);
    }
}

fn write_leading_entries(builder: &mut PayloadBuilder, file: &VectorFile, keys: usize) {
    write_map_header(&mut builder.bytes, keys);
    builder.key("v");
    write_uint(&mut builder.bytes, u64::from(VECTOR_FILE_PAYLOAD_VERSION));
    builder.key("fieldName");
    write_string(&mut builder.bytes, &file.field_name);
    builder.key("dimension");
    write_uint(&mut builder.bytes, file.dimension as u64);
}

fn encoded_id_list(doc_ids: &[String]) -> (Vec<u8>, Vec<u32>) {
    let mut list = Vec::with_capacity(doc_ids.iter().map(|id| id.len() + 5).sum::<usize>() + 5);
    write_array_header(&mut list, doc_ids.len());
    let mut offsets = Vec::with_capacity(doc_ids.len() + 1);
    for doc_id in doc_ids {
        offsets.push(list.len() as u32);
        write_string(&mut list, doc_id);
    }
    offsets.push(list.len() as u32);
    (list, offsets)
}

pub(crate) fn positions_in_id_order(doc_ids: &[String]) -> Vec<u32> {
    let mut positions: Vec<u32> = (0..doc_ids.len() as u32).collect();
    positions.sort_by(|&left, &right| doc_ids[left as usize].cmp(&doc_ids[right as usize]));
    positions
}

fn encode_memory_file(file: &VectorFile) -> Vec<u8> {
    let vectors = f32_bytes(&file.vectors);
    let mut builder = PayloadBuilder::with_capacity(vectors.len() + file.doc_ids.len() * 16 + 64);
    write_leading_entries(&mut builder, file, MEMORY_KEYS);
    builder.key("docIds");
    let (list, _) = encoded_id_list(&file.doc_ids);
    builder.bytes.extend_from_slice(&list);
    builder.key("codes");
    match &file.codes {
        None => write_nil(&mut builder.bytes),
        Some(codes) => {
            write_codes(&mut builder.bytes, codes);
            builder.bytes_entry("records", &codes.records);
        }
    }
    builder.bytes_entry("vectors", &vectors);
    builder.bytes
}

fn encode_disk_file(file: &VectorFile, disk: &DiskColumns) -> Result<(Vec<u8>, Head)> {
    let vectors = f32_bytes(&file.vectors);
    let mut builder = PayloadBuilder::with_capacity(vectors.len() + file.doc_ids.len() * 40 + 256);
    write_leading_entries(&mut builder, file, DISK_KEYS);
    let (list, id_offsets) = encoded_id_list(&file.doc_ids);
    builder.key("docIds");
    let doc_ids_at = builder.offset();
    builder.bytes.extend_from_slice(&list);
    let mut sections = vec![FileSection::of(
        "docIds",
        doc_ids_at,
        &list,
        SEGMENT_PAGE_BYTES,
    )];
    builder.key("codes");
    match &file.codes {
        None => write_nil(&mut builder.bytes),
        Some(codes) => {
            write_codes(&mut builder.bytes, codes);
            let records_at = builder.bytes_entry("records", &codes.records);
            sections.push(FileSection::of(
                "records",
                records_at,
                &codes.records,
                RECORD_PAGE_BYTES,
            ));
        }
    }
    for (name, bytes) in [
        ("magnitudes", f64_bytes(&disk.magnitudes)),
        ("idOffsets", u32_bytes(&id_offsets)),
        ("idOrder", u32_bytes(&positions_in_id_order(&file.doc_ids))),
    ] {
        let at = builder.bytes_entry(name, &bytes);
        sections.push(FileSection::of(name, at, &bytes, SEGMENT_PAGE_BYTES));
    }
    let before_head = builder.offset() + string_entry_bytes("head");
    let vectors_entry = string_entry_bytes("vectors") + binary_header_bytes(vectors.len());
    let vectors_section = FileSection::of("vectors", 0, &vectors, SEGMENT_PAGE_BYTES);
    let head = settled_head(before_head, vectors_entry, |vectors_offset| {
        let mut head = Vec::new();
        write_map_header(&mut head, 1);
        write_string(&mut head, "sections");
        let placed = FileSection {
            offset: vectors_offset,
            ..vectors_section.clone()
        };
        let mut listed = sections.clone();
        listed.push(placed);
        write_sections(&mut head, &listed);
        head
    })?;
    let head_ref = builder.head_entry(&head);
    builder.key("vectors");
    write_binary(&mut builder.bytes, &vectors);
    Ok((builder.bytes, head_ref))
}

/// Writes a vector file payload, and for a disk field the head that lets a reader page its sections in.
pub(crate) fn encode_vector_file(file: &VectorFile) -> Result<(Vec<u8>, Option<Head>)> {
    let count = file.doc_ids.len();
    let held_by_codes = file.codes.as_ref().is_none_or(|codes| {
        codes.centroid.len() == file.dimension
            && codes.records.len() == count * osq_record_bytes(file.dimension, codes.bits)
    });
    let held_by_disk = file
        .disk
        .as_ref()
        .is_none_or(|disk| disk.magnitudes.len() == count);
    if count > VECTOR_FILE_MAX_VECTORS
        || file.vectors.len() != count * file.dimension
        || !held_by_codes
        || !held_by_disk
    {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_SAVE_FAILED,
            format!(
                "The vector file for field \"{}\" holds columns of different lengths",
                file.field_name
            ),
        ));
    }
    match &file.disk {
        None => Ok((encode_memory_file(file), None)),
        Some(disk) => encode_disk_file(file, disk).map(|(bytes, head)| (bytes, Some(head))),
    }
}
