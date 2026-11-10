use std::collections::HashMap;

use super::constants::{ARRAY_POSITION_GAP, PARTIAL_WORD_RUN_CODE_POINTS};
use crate::analysis::{Analyser, TokenOptions};
use crate::error::Result;
use crate::schema::{BaseType, CompiledSchema, SchemaField};
use crate::value::{Map, Value};

pub(crate) struct TermOccurrences {
    pub(crate) term: String,
    pub(crate) frequency: u16,
    pub(crate) positions: Vec<u32>,
}

pub(crate) struct IndexedField {
    pub(crate) path: String,
    pub(crate) length: u32,
    pub(crate) terms: Vec<TermOccurrences>,
}

pub(crate) struct SurfaceCount {
    pub(crate) surface: String,
    pub(crate) token: String,
    pub(crate) count: u32,
}

pub(crate) struct SpellingCount {
    pub(crate) token: String,
    pub(crate) spelling: String,
    pub(crate) count: u32,
}

#[derive(Default)]
pub(crate) struct IndexedDocument {
    pub(crate) text: Vec<IndexedField>,
    pub(crate) surfaces: Vec<SurfaceCount>,
    pub(crate) spellings: Vec<SpellingCount>,
    pub(crate) numeric: Vec<(String, Vec<f64>)>,
    pub(crate) sizes: Vec<(String, f64)>,
    pub(crate) booleans: Vec<(String, Vec<bool>)>,
    pub(crate) enums: Vec<(String, Vec<String>)>,
    pub(crate) geopoints: Vec<(String, f64, f64)>,
    pub(crate) patterns: Vec<(String, Value)>,
}

/// Settings that decide how one index turns a document's text into terms.
pub(crate) struct IndexingOptions<'a> {
    pub(crate) analyser: &'a Analyser,
    pub(crate) track_positions: bool,
    pub(crate) collect_surfaces: bool,
}

/// Returns the value at a dotted path of a document, walking nested maps, or `None` where any step is missing.
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

fn holds_run(spelling: &str) -> bool {
    spelling.chars().count() > PARTIAL_WORD_RUN_CODE_POINTS
}

struct FieldCollector<'a> {
    terms: Vec<TermOccurrences>,
    slots: HashMap<String, usize>,
    length: u32,
    record_surfaces: bool,
    surfaces: &'a mut Vec<SurfaceCount>,
    surface_slots: &'a mut HashMap<String, usize>,
    spellings: Option<SpellingTally<'a>>,
}

type SpellingTally<'a> = (
    &'a mut Vec<SpellingCount>,
    &'a mut HashMap<(String, String), usize>,
);

impl FieldCollector<'_> {
    fn add(&mut self, term: &str, position: u32, surface: Option<&str>) {
        self.length += 1;
        match self.slots.get(term) {
            Some(&slot) => {
                let occurrence = &mut self.terms[slot];
                occurrence.frequency = occurrence.frequency.saturating_add(1);
                occurrence.positions.push(position);
            }
            None => {
                self.slots.insert(term.to_string(), self.terms.len());
                self.terms.push(TermOccurrences {
                    term: term.to_string(),
                    frequency: 1,
                    positions: vec![position],
                });
            }
        }
        if self.record_surfaces
            && let Some(surface) = surface
            && !surface.is_empty()
            && surface != term
        {
            match self.surface_slots.get(surface) {
                Some(&slot) => self.surfaces[slot].count += 1,
                None => {
                    self.surface_slots
                        .insert(surface.to_string(), self.surfaces.len());
                    self.surfaces.push(SurfaceCount {
                        surface: surface.to_string(),
                        token: term.to_string(),
                        count: 1,
                    });
                }
            }
        }
        if let Some((spellings, slots)) = self.spellings.as_mut() {
            let spelling = surface.unwrap_or(term);
            if holds_run(spelling) {
                let key = (term.to_string(), spelling.to_string());
                match slots.get(&key) {
                    Some(&slot) => spellings[slot].count += 1,
                    None => {
                        slots.insert(key, spellings.len());
                        spellings.push(SpellingCount {
                            token: term.to_string(),
                            spelling: spelling.to_string(),
                            count: 1,
                        });
                    }
                }
            }
        }
    }
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

struct DocumentSlots {
    surface_slots: HashMap<String, usize>,
    spelling_slots: HashMap<(String, String), usize>,
}

fn index_text_field(
    field: &SchemaField,
    value: &Value,
    options: &IndexingOptions<'_>,
    indexed: &mut IndexedDocument,
    slots: &mut DocumentSlots,
) -> Result<()> {
    let token_options = TokenOptions {
        collect_surfaces: options.collect_surfaces || field.field_type.partial,
        ..TokenOptions::INDEXING
    };
    let spellings = field
        .field_type
        .partial
        .then_some((&mut indexed.spellings, &mut slots.spelling_slots));
    let mut collector = FieldCollector {
        terms: Vec::new(),
        slots: HashMap::new(),
        length: 0,
        record_surfaces: options.collect_surfaces,
        surfaces: &mut indexed.surfaces,
        surface_slots: &mut slots.surface_slots,
        spellings,
    };
    let mut offset: u32 = 0;
    for text in texts_of(value) {
        let mut last_position: Option<u32> = None;
        options
            .analyser
            .visit_tokens(text, token_options, &mut |term, position, surface, _| {
                collector.add(term, offset.saturating_add(position), surface);
                last_position = Some(position);
            })?;
        if let Some(last) = last_position {
            offset = offset
                .saturating_add(last)
                .saturating_add(1)
                .saturating_add(ARRAY_POSITION_GAP);
        }
    }
    let mut terms = collector.terms;
    if !options.track_positions {
        for occurrence in &mut terms {
            occurrence.positions = Vec::new();
        }
    }
    indexed.text.push(IndexedField {
        path: field.path.clone(),
        length: collector.length,
        terms,
    });
    Ok(())
}

/// Analyses one document into the terms, field lengths, and field values that a segment stores for it, visiting
/// the schema's fields in schema order as every Narsil engine does.
pub(crate) fn index_document(
    document: &Map,
    schema: &CompiledSchema,
    options: &IndexingOptions<'_>,
) -> Result<IndexedDocument> {
    let mut indexed = IndexedDocument::default();
    let mut slots = DocumentSlots {
        surface_slots: HashMap::new(),
        spelling_slots: HashMap::new(),
    };
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
                index_text_field(field, value, options, &mut indexed, &mut slots)?;
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
