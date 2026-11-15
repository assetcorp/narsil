use std::collections::HashSet;
use std::hash::{BuildHasher, RandomState};

use super::constants::{
    CASE_FOLD_EXPANSION_FACTOR, DISTINCT_TERM_BYTES, DOCUMENT_BYTES_PER_VALUE_BYTE,
    DOCUMENT_ENTRY_BYTES, DOCUMENT_PROPERTY_BYTES, DOCUMENT_VALUE_BYTES, ENUM_VALUE_BYTES,
    LANGUAGES_ANALYSED_IN_NGRAMS, NORMALIZATION_EXPANSION_FACTOR, PARTIAL_SPELLING_BYTES,
    PARTIAL_SPELLING_UNIT_BYTES, PATTERN_UNIT_BYTES, TERM_UNIT_BYTES,
    UNITS_PER_TERM_BETWEEN_SEPARATORS, VECTOR_COMPONENT_BYTES, VECTOR_DOCUMENT_BYTES,
};
use crate::analysis::Analyser;
use crate::engine::index::IndexState;
use crate::index::indexed::nested_value;
use crate::schema::{BaseType, MAX_DOCUMENT_NESTING_DEPTH};
use crate::value::{Map, Value};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct DocumentCost {
    pub(crate) bytes: u64,
    pub(crate) terms: u64,
    pub(crate) units: u64,
    pub(crate) values: u64,
}

impl DocumentCost {
    pub(crate) fn add(&mut self, other: &DocumentCost) {
        self.bytes = self.bytes.saturating_add(other.bytes);
        self.terms = self.terms.saturating_add(other.terms);
        self.units = self.units.saturating_add(other.units);
        self.values = self.values.saturating_add(other.values);
    }
}

struct TextField {
    path: String,
    word_indexed: bool,
    partial: bool,
    pattern: bool,
}

pub(crate) struct DocumentBound {
    text_fields: Vec<TextField>,
    enum_paths: Vec<String>,
    vector_fields: Vec<(String, u64)>,
    vector_paths: HashSet<String>,
    units_per_term: u64,
    analyser: Analyser,
}

fn units_of(text: &str) -> u64 {
    let units = match text.is_ascii() {
        true => text.len(),
        false => text.encode_utf16().count(),
    };
    units as u64
}

fn texts_of(value: &Value) -> Vec<&str> {
    match value {
        Value::String(text) => vec![text.as_str()],
        Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

fn value_count_of(value: Option<&Value>) -> u64 {
    match value {
        None | Some(Value::Null) => 0,
        Some(Value::Array(items)) => items.len() as u64,
        Some(_) => 1,
    }
}

fn bytes_cost(bytes: usize) -> u64 {
    (bytes as u64).saturating_mul(DOCUMENT_BYTES_PER_VALUE_BYTE)
}

struct ValueWalk<'a> {
    vector_paths: &'a HashSet<String>,
    cost: DocumentCost,
}

impl ValueWalk<'_> {
    fn charge(&mut self, bytes: u64) {
        self.cost.bytes = self.cost.bytes.saturating_add(bytes);
    }

    fn object(&mut self, map: &Map, depth: usize, path: &str, vector_paths: bool) {
        for (key, entry) in map.iter() {
            self.charge(DOCUMENT_PROPERTY_BYTES.saturating_add(bytes_cost(key.len())));
            let key_path = match (
                vector_paths && !self.vector_paths.is_empty(),
                path.is_empty(),
            ) {
                (false, _) => String::new(),
                (true, true) => key.clone(),
                (true, false) => format!("{path}.{key}"),
            };
            if !vector_paths || !self.vector_paths.contains(&key_path) {
                self.value(entry, depth + 1, &key_path, vector_paths);
            }
        }
    }

    fn value(&mut self, value: &Value, depth: usize, path: &str, vector_paths: bool) {
        self.cost.values = self.cost.values.saturating_add(1);
        self.charge(DOCUMENT_VALUE_BYTES);
        match value {
            Value::String(text) => self.charge(bytes_cost(text.len())),
            Value::Bytes(bytes) => self.charge(bytes_cost(bytes.len())),
            _ if depth > MAX_DOCUMENT_NESTING_DEPTH => {}
            Value::Array(items) => {
                for item in items {
                    self.value(item, depth + 1, path, false);
                }
            }
            Value::Object(map) => self.object(map, depth, path, vector_paths),
            _ => {}
        }
    }
}

fn term_bytes(terms: u64, units: u64, partial: bool) -> u64 {
    let (per_term, per_unit) = match partial {
        true => (
            DISTINCT_TERM_BYTES + PARTIAL_SPELLING_BYTES,
            TERM_UNIT_BYTES + PARTIAL_SPELLING_UNIT_BYTES,
        ),
        false => (DISTINCT_TERM_BYTES, TERM_UNIT_BYTES),
    };
    terms
        .saturating_mul(per_term)
        .saturating_add(units.saturating_mul(per_unit))
}

impl DocumentBound {
    pub(crate) fn of(index: &IndexState) -> DocumentBound {
        let mut text_fields = Vec::new();
        let mut enum_paths = Vec::new();
        let mut vector_fields = Vec::new();
        for field in &index.schema.fields {
            let field_type = &field.field_type;
            match field_type.base {
                BaseType::Enum | BaseType::EnumList => enum_paths.push(field.path.clone()),
                BaseType::Vector => {
                    vector_fields.push((field.path.clone(), u64::from(field_type.dimension)));
                }
                base if base.is_word_indexed() || field_type.pattern => {
                    text_fields.push(TextField {
                        path: field.path.clone(),
                        word_indexed: base.is_word_indexed(),
                        partial: field_type.partial,
                        pattern: field_type.pattern,
                    });
                }
                _ => {}
            }
        }
        let analyser = index.analyser();
        let units_per_term =
            match LANGUAGES_ANALYSED_IN_NGRAMS.contains(&analyser.language().name()) {
                true => 1,
                false => UNITS_PER_TERM_BETWEEN_SEPARATORS,
            };
        DocumentBound {
            text_fields,
            enum_paths,
            vector_fields,
            vector_paths: index.schema.vector_paths.clone(),
            units_per_term,
            analyser,
        }
    }

    pub(crate) fn text_field_count(&self) -> usize {
        self.text_fields.len()
    }

    pub(crate) fn cost_of(&self, document: &Map) -> DocumentCost {
        self.cost_with(document, |text| self.term_cost(text))
            .unwrap_or_default()
    }

    pub(crate) fn counted_cost_of(&self, document: &Map) -> Option<DocumentCost> {
        self.cost_with(document, |text| self.counted_term_cost(text))
    }

    fn term_cost(&self, text: &str) -> Option<(u64, u64)> {
        if let Some(tokens) = self.analyser.custom_document_tokens(text) {
            let tokens = tokens.ok()?;
            let units = tokens.iter().map(|token| units_of(&token.token)).sum();
            return Some((tokens.len() as u64, units));
        }
        let normalized = units_of(text).saturating_mul(NORMALIZATION_EXPANSION_FACTOR);
        let terms = normalized.saturating_add(1).div_ceil(self.units_per_term);
        Some((terms, normalized))
    }

    fn counted_term_cost(&self, text: &str) -> Option<(u64, u64)> {
        let hashing = RandomState::new();
        let mut distinct: HashSet<u64> = HashSet::new();
        let mut units = 0u64;
        self.analyser
            .visit_document_terms(text, &mut |term| {
                units = units.saturating_add(units_of(term));
                distinct.insert(hashing.hash_one(term));
            })
            .ok()?;
        Some((distinct.len() as u64, units))
    }

    fn cost_with(
        &self,
        document: &Map,
        terms_of: impl Fn(&str) -> Option<(u64, u64)>,
    ) -> Option<DocumentCost> {
        let mut walk = ValueWalk {
            vector_paths: &self.vector_paths,
            cost: DocumentCost::default(),
        };
        walk.charge(DOCUMENT_ENTRY_BYTES);
        walk.object(document, 1, "", true);
        let mut cost = walk.cost;
        for (path, dimension) in &self.vector_fields {
            if value_count_of(nested_value(document, path)) > 0 {
                let vector = dimension.saturating_mul(VECTOR_COMPONENT_BYTES);
                cost.bytes = cost
                    .bytes
                    .saturating_add(VECTOR_DOCUMENT_BYTES.saturating_add(vector));
            }
        }
        for field in &self.text_fields {
            let Some(value) = nested_value(document, &field.path) else {
                continue;
            };
            for text in texts_of(value) {
                if field.word_indexed {
                    let (terms, units) = terms_of(text)?;
                    cost.terms = cost.terms.saturating_add(terms);
                    cost.units = cost.units.saturating_add(units);
                    cost.bytes = cost
                        .bytes
                        .saturating_add(term_bytes(terms, units, field.partial));
                }
                if field.pattern {
                    let pattern = units_of(text)
                        .saturating_mul(CASE_FOLD_EXPANSION_FACTOR)
                        .saturating_mul(PATTERN_UNIT_BYTES);
                    cost.bytes = cost.bytes.saturating_add(pattern);
                }
            }
        }
        for path in &self.enum_paths {
            let values = value_count_of(nested_value(document, path));
            cost.bytes = cost
                .bytes
                .saturating_add(values.saturating_mul(ENUM_VALUE_BYTES));
        }
        Some(cost)
    }
}
