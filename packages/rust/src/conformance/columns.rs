use crate::conformance::forms::{numbers_form, strings_form, texts, texts_form};
use crate::error::Result;
use crate::format::keyword_columns::{PartialWords, SurfaceForms, ValueColumn};
use crate::format::keyword_segment::KeywordSegment;
use crate::value::{Map, Value};

fn column_form(field: &str, entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    map.insert("field", Value::String(field.to_string()));
    for (key, value) in entries {
        map.insert(key, value);
    }
    Value::Object(map)
}

fn surface_form(table: &SurfaceForms) -> Result<Value> {
    let texts = texts(&table.text, &table.offsets)?;
    let pairs = texts
        .chunks(2)
        .map(|pair| Value::Array(pair.to_vec()))
        .collect();
    let mut map = Map::new();
    map.insert("text", Value::Array(pairs));
    map.insert("counts", numbers_form(&table.counts));
    Ok(Value::Object(map))
}

fn partial_form(table: &PartialWords) -> Result<Value> {
    let mut map = Map::new();
    map.insert("fields", strings_form(&table.fields));
    map.insert("text", texts_form(&table.text, &table.offsets)?);
    map.insert("tokens", numbers_form(&table.tokens));
    map.insert("counts", numbers_form(&table.counts));
    map.insert("runs", numbers_form(&table.runs));
    map.insert("runOffsets", numbers_form(&table.run_offsets));
    map.insert("runEntries", numbers_form(&table.run_entries));
    Ok(Value::Object(map))
}

fn value_columns_form(columns: &[ValueColumn]) -> Value {
    Value::Array(
        columns
            .iter()
            .map(|column| {
                column_form(
                    &column.field,
                    vec![
                        ("documents", numbers_form(&column.documents)),
                        ("values", numbers_form(&column.values)),
                    ],
                )
            })
            .collect(),
    )
}

/// Puts the JSON form of every column table of `segment` into `map`, under the names that a keyword segment
/// payload gives them: `fieldLengths`, `numeric`, `sizes`, `boolean`, `enum`, `geopoint`, `pattern`,
/// `surfaceForms`, and `partialWords`.
pub(super) fn insert_column_forms(map: &mut Map, segment: &KeywordSegment) -> Result<()> {
    let lengths = segment
        .field_lengths
        .iter()
        .map(|column| {
            column_form(
                &column.field,
                vec![("lengths", numbers_form(&column.lengths))],
            )
        })
        .collect();
    map.insert("fieldLengths", Value::Array(lengths));
    map.insert("numeric", value_columns_form(&segment.numeric));
    map.insert("sizes", value_columns_form(&segment.sizes));
    let booleans = segment
        .boolean
        .iter()
        .map(|column| {
            column_form(
                &column.field,
                vec![
                    ("trueDocuments", numbers_form(&column.true_documents)),
                    ("falseDocuments", numbers_form(&column.false_documents)),
                ],
            )
        })
        .collect();
    map.insert("boolean", Value::Array(booleans));
    let enums = segment
        .enums
        .iter()
        .map(|column| {
            column_form(
                &column.field,
                vec![
                    ("values", strings_form(&column.values)),
                    ("offsets", numbers_form(&column.offsets)),
                    ("documents", numbers_form(&column.documents)),
                ],
            )
        })
        .collect();
    map.insert("enum", Value::Array(enums));
    let geopoints = segment
        .geopoint
        .iter()
        .map(|column| {
            column_form(
                &column.field,
                vec![
                    ("documents", numbers_form(&column.documents)),
                    ("latitudes", numbers_form(&column.latitudes)),
                    ("longitudes", numbers_form(&column.longitudes)),
                ],
            )
        })
        .collect();
    map.insert("geopoint", Value::Array(geopoints));
    let patterns = segment
        .pattern
        .iter()
        .map(|column| {
            column_form(
                &column.field,
                vec![
                    ("documents", numbers_form(&column.documents)),
                    ("runs", numbers_form(&column.runs)),
                    ("offsets", numbers_form(&column.offsets)),
                    ("postings", numbers_form(&column.postings)),
                ],
            )
        })
        .collect();
    map.insert("pattern", Value::Array(patterns));
    let surface = match &segment.surface_forms {
        Some(table) => surface_form(table)?,
        None => Value::Null,
    };
    map.insert("surfaceForms", surface);
    let partial = match &segment.partial_words {
        Some(table) => partial_form(table)?,
        None => Value::Null,
    };
    map.insert("partialWords", partial);
    Ok(())
}
