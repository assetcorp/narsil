use super::WHAT;
use super::lists::{block_summaries_form, documents_form, posting_forms};
use super::sections::{Sections, opened};
use crate::conformance::columns::insert_column_forms;
use crate::conformance::forms::{header_form, numbers_form, strings_form, texts_form, u64_form};
use crate::error::{ErrorCode, Result};
use crate::format::envelope::{Expectation, open_checksummed};
use crate::format::fields::Fields;
use crate::format::keyword_segment::KeywordSegment;
use crate::format::paged_segment::head::{PagedHead, PagedSection};
use crate::format::paged_segment::{PAGED_SEGMENT_ENVELOPE_VERSION, PAGED_SEGMENT_HEAD_VERSION};
use crate::util::bytes::{f64_list, u32_list, u64_list};
use crate::value::{Map, Value, decode_value};

const PLACEMENT_SECTIONS: [&str; 6] = [
    "documentBlocks",
    "tokenOffsets",
    "idOffsets",
    "postings",
    "documents",
    "ids",
];
const COLUMN_SECTIONS: [&str; 9] = [
    "fieldLengths",
    "numeric",
    "sizes",
    "boolean",
    "enum",
    "geopoint",
    "pattern",
    "surfaceForms",
    "partialWords",
];
const UINT32_SECTIONS: [&str; 9] = [
    "documentFrequencies",
    "postingOffsets",
    "blockLists",
    "blockListOffsets",
    "positionOffsets",
    "positions",
    "idOrder",
    "removalOffsets",
    "removals",
];
const UINT64_SECTIONS: [&str; 2] = ["seqNos", "primaryTerms"];
const FLOAT64_SECTIONS: [&str; 1] = ["tokenTotals"];

fn column_forms(sections: &Sections<'_>, token_count: usize) -> Result<Map> {
    let mut lists = Map::new();
    for name in COLUMN_SECTIONS {
        if let Some(section) = sections.head.section(name) {
            lists.insert(name, decode_value(sections.bytes(section)?)?);
        }
    }
    let columns = Fields::new(&lists, ErrorCode::PERSISTENCE_LOAD_FAILED, "");
    let mut segment = KeywordSegment::default();
    segment.decode_columns(&columns, sections.head.document_count, token_count)?;
    let mut forms = Map::new();
    insert_column_forms(&mut forms, &segment)?;
    Ok(forms)
}

fn section_form(sections: &Sections<'_>, section: &PagedSection, columns: &Map) -> Result<Value> {
    let name = section.name.as_str();
    let bytes = sections.bytes(section)?;
    if COLUMN_SECTIONS.contains(&name)
        && let Some(form) = columns.get(name)
    {
        return Ok(form.clone());
    }
    if name == "blockSummaries" {
        return block_summaries_form(bytes);
    }
    if name == "idSample" {
        return decode_value(bytes);
    }
    if UINT32_SECTIONS.contains(&name) {
        return Ok(numbers_form(&u32_list(bytes, name)?));
    }
    if UINT64_SECTIONS.contains(&name) {
        return Ok(u64_form(&u64_list(bytes, name)?));
    }
    if FLOAT64_SECTIONS.contains(&name) {
        return Ok(numbers_form(&f64_list(bytes, name)?));
    }
    Ok(Value::Bytes(bytes.to_vec()))
}

fn head_form(head: &PagedHead) -> Value {
    let mut form = Map::new();
    form.insert("v", Value::Number(f64::from(PAGED_SEGMENT_HEAD_VERSION)));
    form.insert("schema", Value::Object(head.schema.clone()));
    form.insert("tombstones", strings_form(&head.tombstones));
    form.insert(
        "documentCount",
        Value::Number(f64::from(head.document_count)),
    );
    form.insert("fieldNames", strings_form(&head.field_names));
    Value::Object(form)
}

/// Reads a paged keyword segment file and returns its JSON form: the header, the head, and every section.
pub(crate) fn read_paged_segment(bytes: &[u8]) -> Result<Value> {
    let expected = Expectation {
        version: PAGED_SEGMENT_ENVELOPE_VERSION,
        what: WHAT,
        allows_compression: false,
    };
    let (header, payload) = open_checksummed(bytes, &expected)?;
    let sections = opened(payload.bytes())?;
    let token_offsets = sections.u32s("tokenOffsets")?;
    let columns = column_forms(&sections, token_offsets.len().saturating_sub(1))?;
    let mut forms = Map::new();
    for section in &sections.head.sections {
        if !PLACEMENT_SECTIONS.contains(&section.name.as_str()) {
            forms.insert(
                section.name.as_str(),
                section_form(&sections, section, &columns)?,
            );
        }
    }
    forms.insert(
        "tokens",
        texts_form(sections.named("tokens")?, &token_offsets)?,
    );
    forms.insert(
        "ids",
        texts_form(sections.named("ids")?, &sections.u32s("idOffsets")?)?,
    );
    posting_forms(&sections, &mut forms)?;
    forms.insert("documents", documents_form(&sections)?);
    let mut form = Map::new();
    form.insert("header", header_form(&header));
    form.insert("head", head_form(&sections.head));
    form.insert("sections", Value::Object(forms));
    Ok(Value::Object(form))
}
