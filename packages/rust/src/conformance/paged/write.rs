use super::WHAT;
use crate::conformance::forms::{form_error, header_from_form, object};
use crate::conformance::keyword::segment_from_form;
use crate::error::Result;
use crate::format::envelope::{Compression, pack};
use crate::format::paged_segment::{PAGED_SEGMENT_ENVELOPE_VERSION, encode_paged_segment};
use crate::value::{Map, Value};

const WRITTEN_HEAD_KEYS: [&str; 4] = ["schema", "tombstones", "documentCount", "fieldNames"];
const SECTIONS_FROM_PAYLOAD: [&str; 16] = [
    "ids",
    "documents",
    "tokens",
    "idOrder",
    "documentFrequencies",
    "postingOffsets",
    "postingDocuments",
    "postingFrequencies",
    "postingFields",
    "fieldLengths",
    "numeric",
    "sizes",
    "boolean",
    "enum",
    "geopoint",
    "pattern",
];
const NULL_WHEN_ABSENT: [&str; 4] = [
    "positionOffsets",
    "positions",
    "surfaceForms",
    "partialWords",
];
const WRITE_RECORD_SECTIONS: [&str; 2] = ["seqNos", "primaryTerms"];

fn keyword_payload_of(form: &Map) -> Result<Map> {
    let head = object(form.get("head"), "head")?;
    let sections = object(form.get("sections"), "sections")?;
    let mut payload = Map::new();
    for key in WRITTEN_HEAD_KEYS {
        let value = head
            .get(key)
            .ok_or_else(|| form_error(format!("head has no {key}")))?;
        payload.insert(key, value.clone());
    }
    for name in SECTIONS_FROM_PAYLOAD {
        let value = sections
            .get(name)
            .ok_or_else(|| form_error(format!("sections has no {name}")))?;
        payload.insert(name, value.clone());
    }
    for name in NULL_WHEN_ABSENT {
        payload.insert(name, sections.get(name).cloned().unwrap_or(Value::Null));
    }
    for name in WRITE_RECORD_SECTIONS {
        if let Some(value) = sections.get(name) {
            payload.insert(name, value.clone());
        }
    }
    Ok(payload)
}

/// Writes a paged keyword segment file from its JSON form, laying out its sections as a checkpoint does.
pub(crate) fn write_paged_segment(form: &Map) -> Result<Vec<u8>> {
    let header = header_from_form(form)?;
    if header.version != PAGED_SEGMENT_ENVELOPE_VERSION
        || header.compression != Compression::None
        || !header.checksum
    {
        return Err(form_error(
            "a paged segment's header names version 6, uncompressed, with a checksum",
        ));
    }
    let segment = segment_from_form(&keyword_payload_of(form)?)?;
    let tombstones = segment.tombstones.clone();
    let file = encode_paged_segment(&segment, tombstones)?;
    let mut payload = Vec::with_capacity(usize::try_from(file.payload_length()).unwrap_or(0));
    file.write_payload(&mut |bytes| {
        payload.extend_from_slice(bytes);
        Ok(())
    })?;
    pack(
        &payload,
        PAGED_SEGMENT_ENVELOPE_VERSION,
        Compression::None,
        WHAT,
    )
}
