use super::{
    PAGED_SEGMENT_HEAD_VERSION, PAYLOAD_PREFIX_BYTES, SECTION_ALIGNMENT_BYTES, SEGMENT_PAGE_BYTES,
};
use crate::error::{ErrorCode, NarsilError, Result, load_failed};
use crate::format::fields::{non_negative_safe_integer, string_list};
use crate::format::file_sections::page_checksums;
use crate::util::hash::crc32;
use crate::value::{
    Map, Value, decode_value, write_array_header, write_binary, write_map_header, write_string,
    write_uint,
};

const MAX_UINT32: f64 = 4_294_967_295.0;
const HEAD_KEYS: usize = 6;
const SECTION_KEYS: usize = 5;
const STABLE_HEAD_ATTEMPTS: usize = 8;

/// One section of a paged keyword segment: where its bytes start in the payload, how many there are, and the
/// CRC-32 of each page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PagedSection {
    pub(crate) name: String,
    pub(crate) offset: u64,
    pub(crate) length: u64,
    pub(crate) page_bytes: u64,
    pub(crate) checksums: Vec<u8>,
}

impl PagedSection {
    pub(crate) fn page_count(&self) -> u64 {
        self.length.div_ceil(self.page_bytes.max(1))
    }

    pub(crate) fn checksum_of_page(&self, page: u64) -> Option<u32> {
        let at = usize::try_from(page).ok()?.checked_mul(4)?;
        let bytes = self.checksums.get(at..at.checked_add(4)?)?;
        Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
}

/// The decoded head of a paged keyword segment.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PagedHead {
    pub(crate) schema: Map,
    pub(crate) tombstones: Vec<String>,
    pub(crate) document_count: u32,
    pub(crate) field_names: Vec<String>,
    pub(crate) sections: Vec<PagedSection>,
}

impl PagedHead {
    pub(crate) fn section(&self, name: &str) -> Option<&PagedSection> {
        self.sections.iter().find(|section| section.name == name)
    }
}

fn decode_section(raw: &Value, what: &str, allowed_page_bytes: &[u64]) -> Result<PagedSection> {
    let Value::Object(entry) = raw else {
        return load_failed(format!("The {what} lists a section that is not a map"));
    };
    let name = match entry.get("name") {
        Some(Value::String(name)) if !name.is_empty() => name.clone(),
        _ => return load_failed(format!("The {what} lists a section without a name")),
    };
    let (Some(offset), Some(length)) = (
        non_negative_safe_integer(entry.get("offset")),
        non_negative_safe_integer(entry.get("length")),
    ) else {
        return load_failed(format!(
            "The {what} gives section \"{name}\" an invalid place"
        ));
    };
    let found = entry.get("pageBytes");
    let allowed = match found {
        Some(Value::Number(bytes)) => allowed_page_bytes
            .iter()
            .copied()
            .find(|&size| size as f64 == *bytes),
        _ => None,
    };
    let Some(page_bytes) = allowed else {
        let shown = found.map_or_else(|| "undefined".to_string(), Value::to_json);
        return load_failed(format!(
            "The {what} gives section \"{name}\" a page size of {shown}"
        ));
    };
    let Some(Value::Bytes(checksums)) = entry.get("checksums") else {
        return load_failed(format!("The {what} gives section \"{name}\" no checksums"));
    };
    let wanted = length.div_ceil(page_bytes).saturating_mul(4);
    if checksums.len() as u64 != wanted {
        return load_failed(format!(
            "The {what} gives section \"{name}\" {} bytes of checksums",
            checksums.len()
        ));
    }
    Ok(PagedSection {
        name,
        offset,
        length,
        page_bytes,
        checksums: checksums.clone(),
    })
}

/// Decodes the section list of a head whose payload holds `payload_length` bytes, raising
/// `PERSISTENCE_LOAD_FAILED` for a section whose page size `allowed_page_bytes` leaves out, one that repeats a
/// name, one that ends outside the payload, and one that overlaps another.
pub(crate) fn decode_sections(
    raw: Option<&Value>,
    payload_length: u64,
    what: &str,
    allowed_page_bytes: &[u64],
) -> Result<Vec<PagedSection>> {
    let Some(Value::Array(list)) = raw else {
        return load_failed(format!("The {what} holds no section list"));
    };
    let sections = list
        .iter()
        .map(|entry| decode_section(entry, what, allowed_page_bytes))
        .collect::<Result<Vec<_>>>()?;
    let mut names = std::collections::HashSet::with_capacity(sections.len());
    for section in &sections {
        if !names.insert(section.name.as_str()) {
            return load_failed(format!("The {what} repeats section \"{}\"", section.name));
        }
        if section.offset.saturating_add(section.length) > payload_length {
            return load_failed(format!(
                "The {what} ends section \"{}\" outside the payload",
                section.name
            ));
        }
    }
    let mut by_offset: Vec<&PagedSection> = sections.iter().collect();
    by_offset.sort_by_key(|section| section.offset);
    for pair in by_offset.windows(2) {
        if pair[0].offset + pair[0].length > pair[1].offset {
            return load_failed(format!(
                "The {what} overlaps section \"{}\" with \"{}\"",
                pair[0].name, pair[1].name
            ));
        }
    }
    Ok(sections)
}

/// Decodes the head of a paged keyword segment whose payload holds `payload_length` bytes, checking every section
/// against the payload as the format requires.
pub(crate) fn decode_paged_head(head: &[u8], payload_length: u64, what: &str) -> Result<PagedHead> {
    let raw = decode_value(head).map_err(|error| {
        NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!("The head of {what} is not MessagePack: {}", error.message()),
        )
    })?;
    let Value::Object(entry) = &raw else {
        return load_failed(format!("The head of {what} is not a map"));
    };
    if !matches!(entry.get("v"), Some(Value::Number(version)) if *version == PAGED_SEGMENT_HEAD_VERSION as f64)
    {
        let shown = entry
            .get("v")
            .map_or_else(|| "undefined".to_string(), Value::to_json);
        return Err(NarsilError::new(
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            format!(
                "The head of {what} was written in layout {shown}, and this build reads layout {PAGED_SEGMENT_HEAD_VERSION} alone"
            ),
        ));
    }
    let schema = match entry.get("schema") {
        Some(Value::Object(schema))
            if schema
                .values()
                .all(|value| matches!(value, Value::String(_))) =>
        {
            schema.clone()
        }
        _ => return load_failed(format!("The head of {what} holds no schema")),
    };
    let Some(tombstones) = string_list(entry.get("tombstones")) else {
        return load_failed(format!("The head of {what} holds no tombstone list"));
    };
    let Some(field_names) = string_list(entry.get("fieldNames")) else {
        return load_failed(format!("The head of {what} holds no field names"));
    };
    let document_count = match entry.get("documentCount") {
        Some(Value::Number(count)) if count.fract() == 0.0 && *count >= 0.0 => *count,
        _ => {
            return load_failed(format!(
                "The head of {what} holds an invalid document count"
            ));
        }
    };
    if document_count > MAX_UINT32 {
        return load_failed(format!(
            "The head of {what} holds a document count above uint32"
        ));
    }
    let sections = decode_sections(
        entry.get("sections"),
        payload_length,
        &format!("head of {what}"),
        &[SEGMENT_PAGE_BYTES],
    )?;
    Ok(PagedHead {
        schema,
        tombstones,
        document_count: document_count as u32,
        field_names,
        sections,
    })
}

/// One section that a writer plans to place in a paged segment, in the order that it writes them.
pub(crate) struct PlannedSection {
    pub(crate) name: &'static str,
    pub(crate) bytes: Vec<u8>,
}

/// One section that a head lists, known by its length and the CRC-32 of each of its pages, so that a writer can
/// list a section that it holds in a scratch file.
pub(crate) struct SectionPlan {
    pub(crate) name: &'static str,
    pub(crate) length: u64,
    pub(crate) checksums: Vec<u8>,
}

impl SectionPlan {
    /// Returns the plan of `section`, whose bytes the writer holds whole.
    pub(crate) fn of(section: &PlannedSection) -> SectionPlan {
        SectionPlan {
            name: section.name,
            length: section.bytes.len() as u64,
            checksums: page_checksums(&section.bytes, SEGMENT_PAGE_BYTES as usize),
        }
    }
}

/// The encoded start of a paged segment's payload: the length and CRC-32 of the head, the head itself, and every
/// section placed on its 4-byte boundary.
pub(crate) struct EncodedHead {
    pub(crate) prefix: [u8; PAYLOAD_PREFIX_BYTES],
    pub(crate) head: Vec<u8>,
    pub(crate) offsets: Vec<u64>,
    pub(crate) payload_length: u64,
}

fn aligned_up(offset: u64) -> u64 {
    offset.div_ceil(SECTION_ALIGNMENT_BYTES) * SECTION_ALIGNMENT_BYTES
}

fn encode_head(fields: &PagedHead, planned: &[SectionPlan], offsets: &[u64]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    write_map_header(&mut out, HEAD_KEYS);
    write_string(&mut out, "v");
    write_uint(&mut out, u64::from(PAGED_SEGMENT_HEAD_VERSION));
    write_string(&mut out, "schema");
    write_map_header(&mut out, fields.schema.len());
    for (path, type_value) in fields.schema.iter() {
        let Value::String(type_name) = type_value else {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!("The schema gives {path} a type that is not a string"),
            ));
        };
        write_string(&mut out, path);
        write_string(&mut out, type_name);
    }
    write_string(&mut out, "tombstones");
    write_array_header(&mut out, fields.tombstones.len());
    for id in &fields.tombstones {
        write_string(&mut out, id);
    }
    write_string(&mut out, "documentCount");
    write_uint(&mut out, u64::from(fields.document_count));
    write_string(&mut out, "fieldNames");
    write_array_header(&mut out, fields.field_names.len());
    for name in &fields.field_names {
        write_string(&mut out, name);
    }
    write_string(&mut out, "sections");
    write_array_header(&mut out, planned.len());
    for (section, offset) in planned.iter().zip(offsets) {
        write_map_header(&mut out, SECTION_KEYS);
        write_string(&mut out, "name");
        write_string(&mut out, section.name);
        write_string(&mut out, "offset");
        write_uint(&mut out, *offset);
        write_string(&mut out, "length");
        write_uint(&mut out, section.length);
        write_string(&mut out, "pageBytes");
        write_uint(&mut out, SEGMENT_PAGE_BYTES);
        write_string(&mut out, "checksums");
        write_binary(&mut out, &section.checksums);
    }
    Ok(out)
}

/// Encodes the head of a paged segment that holds `planned` in order, placing each section on a 4-byte boundary
/// after the head and repeating until the head's own length settles.
pub(crate) fn encode_paged_head(
    fields: &PagedHead,
    planned: &[SectionPlan],
) -> Result<EncodedHead> {
    let mut head_length = 0usize;
    for _ in 0..STABLE_HEAD_ATTEMPTS {
        let sections_start = aligned_up((PAYLOAD_PREFIX_BYTES + head_length) as u64);
        let mut cursor = sections_start;
        let offsets: Vec<u64> = planned
            .iter()
            .map(|section| {
                let offset = aligned_up(cursor);
                cursor = offset + section.length;
                offset
            })
            .collect();
        let head = encode_head(fields, planned, &offsets)?;
        if head.len() != head_length {
            head_length = head.len();
            continue;
        }
        let mut prefix = [0u8; PAYLOAD_PREFIX_BYTES];
        prefix[0..4].copy_from_slice(&(head.len() as u32).to_le_bytes());
        prefix[4..8].copy_from_slice(&crc32(&head).to_le_bytes());
        return Ok(EncodedHead {
            prefix,
            head,
            offsets,
            payload_length: cursor,
        });
    }
    Err(NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        "The head of a paged segment did not settle on one length",
    ))
}
