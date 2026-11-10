use super::constants::ARRAY_POSITION_GAP;
use crate::analysis::{Analyser, TokenOptions};
use crate::error::Result;
use crate::keyword::tokens::PackedTokens;
use crate::schema::{BaseType, CompiledSchema, SchemaField};
use crate::value::{Map, Value};

pub(crate) struct IndexedField {
    pub(crate) path: String,
    pub(crate) partial: bool,
    pub(crate) length: u32,
    pub(crate) tokens: PackedTokens,
}

#[derive(Default)]
pub(crate) struct IndexedDocument {
    pub(crate) text: Vec<IndexedField>,
    pub(crate) numeric: Vec<(String, Vec<f64>)>,
    pub(crate) sizes: Vec<(String, f64)>,
    pub(crate) booleans: Vec<(String, Vec<bool>)>,
    pub(crate) enums: Vec<(String, Vec<String>)>,
    pub(crate) geopoints: Vec<(String, f64, f64)>,
    pub(crate) patterns: Vec<(String, Value)>,
}

pub(crate) struct IndexingOptions<'a> {
    pub(crate) analyser: &'a Analyser,
    pub(crate) collect_surfaces: bool,
}

pub(crate) fn nested_value<'a>(document: &'a Map, path: &str) -> Option<&'a Value> {
    let mut parts = path.split('.');
    let first = parts.next()?;
    let mut current = document.get(first)?;
    for part in parts {
        let Value::Object(map) = current else {
            return None;
        };
        current = map.get(part)?;
    }
    Some(current)
}

fn texts_of(value: &Value) -> Vec<&str> {
    match value {
        Value::String(text) => vec![text.as_str()],
        Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

fn numbers_of(value: &Value) -> Vec<f64> {
    match value {
        Value::Number(number) => vec![*number],
        Value::Array(items) => items.iter().filter_map(Value::as_f64).collect(),
        _ => Vec::new(),
    }
}

fn booleans_of(value: &Value) -> Vec<bool> {
    match value {
        Value::Bool(flag) => vec![*flag],
        Value::Array(items) => items.iter().filter_map(Value::as_bool).collect(),
        _ => Vec::new(),
    }
}

fn value_size(value: &Value) -> f64 {
    match value {
        Value::Array(items) => items.len() as f64,
        Value::String(text) if text.is_empty() => 0.0,
        _ => 1.0,
    }
}

fn keeps_value_size(base: BaseType) -> bool {
    matches!(base, BaseType::String | BaseType::Verbatim) || base.is_list()
}

fn geopoint_of(value: &Value) -> Option<(f64, f64)> {
    let Value::Object(point) = value else {
        return None;
    };
    Some((point.get("lat")?.as_f64()?, point.get("lon")?.as_f64()?))
}

fn index_text_field(
    field: &SchemaField,
    value: &Value,
    options: &IndexingOptions<'_>,
) -> Result<IndexedField> {
    let token_options = TokenOptions {
        collect_surfaces: options.collect_surfaces,
        ..TokenOptions::INDEXING
    };
    let mut tokens = PackedTokens::default();
    let mut offset: u32 = 0;
    for text in texts_of(value) {
        if let Some(last) = options
            .analyser
            .pack_text(text, token_options, offset, &mut tokens)?
        {
            offset = offset
                .saturating_add(last)
                .saturating_add(1)
                .saturating_add(ARRAY_POSITION_GAP);
        }
    }
    Ok(IndexedField {
        path: field.path.clone(),
        partial: field.field_type.partial,
        length: u32::try_from(tokens.len()).unwrap_or(u32::MAX),
        tokens,
    })
}

pub(crate) fn index_document(
    document: &Map,
    schema: &CompiledSchema,
    options: &IndexingOptions<'_>,
) -> Result<IndexedDocument> {
    let mut indexed = IndexedDocument::default();
    for field in &schema.fields {
        let Some(value) = nested_value(document, &field.path) else {
            continue;
        };
        if matches!(value, Value::Null) {
            continue;
        }
        let base = field.field_type.base;
        if keeps_value_size(base) {
            indexed.sizes.push((field.path.clone(), value_size(value)));
        }
        if field.field_type.pattern {
            indexed.patterns.push((field.path.clone(), value.clone()));
        }
        match base {
            BaseType::String | BaseType::StringList => {
                indexed.text.push(index_text_field(field, value, options)?);
            }
            BaseType::Number | BaseType::NumberList => {
                indexed
                    .numeric
                    .push((field.path.clone(), numbers_of(value)));
            }
            BaseType::Boolean | BaseType::BooleanList => {
                indexed
                    .booleans
                    .push((field.path.clone(), booleans_of(value)));
            }
            BaseType::Enum | BaseType::EnumList => {
                let values = texts_of(value).into_iter().map(str::to_string).collect();
                indexed.enums.push((field.path.clone(), values));
            }
            BaseType::Geopoint => {
                if let Some((latitude, longitude)) = geopoint_of(value) {
                    indexed
                        .geopoints
                        .push((field.path.clone(), latitude, longitude));
                }
            }
            BaseType::Verbatim | BaseType::VerbatimList | BaseType::Vector => {}
        }
    }
    Ok(indexed)
}
