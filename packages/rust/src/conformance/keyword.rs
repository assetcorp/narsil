use crate::conformance::columns::insert_column_forms;
use crate::conformance::forms::{
    f64s, form_error, header_form, header_from_form, joined, list, numbers_form, object,
    packed_form, packed_from_form, string, strings, strings_form, texts_form, texts_from_form,
    u16s, u32_of, u32s, u64_form, u64s,
};
use crate::error::Result;
use crate::format::envelope::{Expectation, open_checksummed, pack};
use crate::format::keyword_columns::{
    BooleanColumn, EnumColumn, FieldLengthColumn, GeopointColumn, PartialWords, PatternColumn,
    SurfaceForms, ValueColumn,
};
use crate::format::keyword_segment::{
    KEYWORD_SEGMENT_ENVELOPE_VERSION, KeywordSegment, Positions, WriteRecords,
    decode_keyword_segment, encode_keyword_segment,
};
use crate::value::{Map, Value};

fn entry(map: &mut Map, key: &str, value: Value) {
    map.insert(key, value);
}

fn segment_form(segment: &KeywordSegment) -> Result<Value> {
    let mut map = Map::new();
    entry(&mut map, "v", Value::Number(1.0));
    entry(&mut map, "schema", Value::Object(segment.schema.clone()));
    entry(&mut map, "tombstones", strings_form(&segment.tombstones));
    entry(
        &mut map,
        "documentCount",
        Value::Number(segment.document_count as f64),
    );
    entry(
        &mut map,
        "ids",
        texts_form(&segment.ids, &segment.id_offsets)?,
    );
    entry(&mut map, "idOrder", numbers_form(&segment.id_order));
    entry(
        &mut map,
        "documents",
        packed_form(&segment.documents, &segment.document_offsets)?,
    );
    entry(&mut map, "fieldNames", strings_form(&segment.field_names));
    entry(
        &mut map,
        "tokens",
        texts_form(&segment.tokens, &segment.token_offsets)?,
    );
    entry(
        &mut map,
        "documentFrequencies",
        numbers_form(&segment.document_frequencies),
    );
    entry(
        &mut map,
        "postingOffsets",
        numbers_form(&segment.posting_offsets),
    );
    entry(
        &mut map,
        "postingDocuments",
        numbers_form(&segment.posting_documents),
    );
    entry(
        &mut map,
        "postingFrequencies",
        numbers_form(&segment.posting_frequencies),
    );
    entry(
        &mut map,
        "postingFields",
        numbers_form(&segment.posting_fields),
    );
    let (offsets, positions) = match &segment.positions {
        Some(positions) => (
            numbers_form(&positions.offsets),
            numbers_form(&positions.values),
        ),
        None => (Value::Null, Value::Null),
    };
    entry(&mut map, "positionOffsets", offsets);
    entry(&mut map, "positions", positions);
    insert_column_forms(&mut map, segment)?;
    if let Some(records) = &segment.write_records {
        entry(&mut map, "seqNos", u64_form(&records.seq_nos));
        entry(&mut map, "primaryTerms", u64_form(&records.primary_terms));
    }
    Ok(Value::Object(map))
}

pub(crate) fn read_keyword_segment(bytes: &[u8]) -> Result<Value> {
    let expected = Expectation {
        version: KEYWORD_SEGMENT_ENVELOPE_VERSION,
        what: "keyword segment",
        allows_compression: true,
    };
    let (header, payload) = open_checksummed(bytes, &expected)?;
    let segment = decode_keyword_segment(payload.bytes())?;
    let mut form = Map::new();
    form.insert("header", header_form(&header));
    form.insert("payload", segment_form(&segment)?);
    Ok(Value::Object(form))
}

fn columns<T>(
    value: Option<&Value>,
    what: &str,
    decode: impl Fn(&Map, String) -> Result<T>,
) -> Result<Vec<T>> {
    list(value, what)?
        .iter()
        .map(|item| {
            let column = object(Some(item), what)?;
            decode(column, string(column.get("field"), what)?)
        })
        .collect()
}

fn value_columns(value: Option<&Value>, what: &str) -> Result<Vec<ValueColumn>> {
    columns(value, what, |column, field| {
        Ok(ValueColumn {
            field,
            documents: u32s(column.get("documents"), what)?,
            values: f64s(column.get("values"), what)?,
        })
    })
}

fn surface_from_form(value: Option<&Value>) -> Result<Option<SurfaceForms>> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let table = object(Some(value), "surfaceForms")?;
    let mut parts = Vec::new();
    for pair in list(table.get("text"), "surfaceForms.text")? {
        let texts = strings(Some(pair), "surfaceForms.text")?;
        if texts.len() != 2 {
            return Err(form_error(
                "surfaceForms.text holds an entry that is not a pair",
            ));
        }
        parts.extend(texts.into_iter().map(String::into_bytes));
    }
    let (text, offsets) = joined(parts);
    Ok(Some(SurfaceForms {
        text,
        offsets,
        counts: u32s(table.get("counts"), "surfaceForms.counts")?,
    }))
}

fn partial_from_form(value: Option<&Value>) -> Result<Option<PartialWords>> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let table = object(Some(value), "partialWords")?;
    let (text, offsets) = texts_from_form(table.get("text"), "partialWords.text")?;
    Ok(Some(PartialWords {
        fields: strings(table.get("fields"), "partialWords.fields")?,
        text,
        offsets,
        tokens: u32s(table.get("tokens"), "partialWords.tokens")?,
        counts: u32s(table.get("counts"), "partialWords.counts")?,
        runs: u32s(table.get("runs"), "partialWords.runs")?,
        run_offsets: u32s(table.get("runOffsets"), "partialWords.runOffsets")?,
        run_entries: u32s(table.get("runEntries"), "partialWords.runEntries")?,
    }))
}

/// Builds a keyword segment from the JSON form of its payload.
pub(super) fn segment_from_form(payload: &Map) -> Result<KeywordSegment> {
    let (ids, id_offsets) = texts_from_form(payload.get("ids"), "ids")?;
    let (documents, document_offsets) = packed_from_form(payload.get("documents"), "documents")?;
    let (tokens, token_offsets) = texts_from_form(payload.get("tokens"), "tokens")?;
    let positions = match (payload.get("positionOffsets"), payload.get("positions")) {
        (Some(Value::Null) | None, Some(Value::Null) | None) => None,
        (offsets, values) => Some(Positions {
            offsets: u32s(offsets, "positionOffsets")?,
            values: u32s(values, "positions")?,
        }),
    };
    let write_records = match (payload.get("seqNos"), payload.get("primaryTerms")) {
        (None, None) => None,
        (seq_nos, terms) => Some(WriteRecords {
            seq_nos: u64s(seq_nos, "seqNos")?,
            primary_terms: u64s(terms, "primaryTerms")?,
        }),
    };
    Ok(KeywordSegment {
        schema: object(payload.get("schema"), "schema")?.clone(),
        tombstones: strings(payload.get("tombstones"), "tombstones")?,
        document_count: u32_of(payload.get("documentCount"), "documentCount")?,
        ids,
        id_offsets,
        id_order: u32s(payload.get("idOrder"), "idOrder")?,
        documents,
        document_offsets,
        field_names: strings(payload.get("fieldNames"), "fieldNames")?,
        tokens,
        token_offsets,
        document_frequencies: u32s(payload.get("documentFrequencies"), "documentFrequencies")?,
        posting_offsets: u32s(payload.get("postingOffsets"), "postingOffsets")?,
        posting_documents: u32s(payload.get("postingDocuments"), "postingDocuments")?,
        posting_frequencies: u16s(payload.get("postingFrequencies"), "postingFrequencies")?,
        posting_fields: u16s(payload.get("postingFields"), "postingFields")?,
        positions,
        field_lengths: columns(
            payload.get("fieldLengths"),
            "fieldLengths",
            |column, field| {
                Ok(FieldLengthColumn {
                    field,
                    lengths: u32s(column.get("lengths"), "fieldLengths")?,
                })
            },
        )?,
        numeric: value_columns(payload.get("numeric"), "numeric")?,
        sizes: value_columns(payload.get("sizes"), "sizes")?,
        boolean: columns(payload.get("boolean"), "boolean", |column, field| {
            Ok(BooleanColumn {
                field,
                true_documents: u32s(column.get("trueDocuments"), "boolean")?,
                false_documents: u32s(column.get("falseDocuments"), "boolean")?,
            })
        })?,
        enums: columns(payload.get("enum"), "enum", |column, field| {
            Ok(EnumColumn {
                field,
                values: strings(column.get("values"), "enum")?,
                offsets: u32s(column.get("offsets"), "enum")?,
                documents: u32s(column.get("documents"), "enum")?,
            })
        })?,
        geopoint: columns(payload.get("geopoint"), "geopoint", |column, field| {
            Ok(GeopointColumn {
                field,
                documents: u32s(column.get("documents"), "geopoint")?,
                latitudes: f64s(column.get("latitudes"), "geopoint")?,
                longitudes: f64s(column.get("longitudes"), "geopoint")?,
            })
        })?,
        pattern: columns(payload.get("pattern"), "pattern", |column, field| {
            Ok(PatternColumn {
                field,
                documents: u32s(column.get("documents"), "pattern")?,
                runs: u32s(column.get("runs"), "pattern")?,
                offsets: u32s(column.get("offsets"), "pattern")?,
                postings: u32s(column.get("postings"), "pattern")?,
            })
        })?,
        surface_forms: surface_from_form(payload.get("surfaceForms"))?,
        partial_words: partial_from_form(payload.get("partialWords"))?,
        write_records,
    })
}

pub(crate) fn write_keyword_segment(form: &Map) -> Result<Vec<u8>> {
    let header = header_from_form(form)?;
    let segment = segment_from_form(object(form.get("payload"), "payload")?)?;
    let payload = encode_keyword_segment(&segment)?;
    pack(
        &payload,
        header.version,
        header.compression,
        "keyword segment",
    )
}
