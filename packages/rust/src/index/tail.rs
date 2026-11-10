use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use super::core_values::CoreStoredValues;
use super::derived::{DerivedColumns, KeptColumns, SortedNumbers};
use super::indexed::IndexedDocument;
use super::stored_values::path_value;
use crate::error::Result;
use crate::keyword::growing::{GrowingSegment, Indexed};
use crate::keyword::tokens::SegmentFieldTokens;
use crate::ordering::{SortValues, push_reduced};
use crate::value::{Map, Value};

#[derive(Default, Clone)]
pub(crate) struct TailColumns {
    pub(crate) numeric: BTreeMap<String, Vec<(u32, f64)>>,
    pub(crate) sizes: BTreeMap<String, Vec<(u32, f64)>>,
    pub(crate) booleans: BTreeMap<String, (Vec<u32>, Vec<u32>)>,
    pub(crate) enums: BTreeMap<String, BTreeMap<String, Vec<u32>>>,
    pub(crate) geopoints: BTreeMap<String, Vec<(u32, f64, f64)>>,
    pub(crate) patterns: BTreeMap<String, Vec<(u32, Value)>>,
}

pub(crate) enum Appended {
    Stored,
    SegmentFull(IndexedDocument),
}

pub(crate) struct TailSegment {
    pub(crate) ids: Vec<String>,
    pub(crate) id_lookup: HashMap<String, u32>,
    pub(crate) documents: Vec<Arc<Map>>,
    pub(crate) keyword: GrowingSegment,
    pub(crate) field_names: Vec<String>,
    field_slots: HashMap<String, u16>,
    pub(crate) columns: TailColumns,
    pub(crate) track_positions: bool,
    pub(crate) derived: DerivedColumns,
    name_ranks: Vec<u16>,
}

impl Clone for TailSegment {
    fn clone(&self) -> TailSegment {
        TailSegment {
            ids: self.ids.clone(),
            id_lookup: self.id_lookup.clone(),
            documents: self.documents.clone(),
            keyword: self.keyword.clone(),
            field_names: self.field_names.clone(),
            field_slots: self.field_slots.clone(),
            columns: self.columns.clone(),
            track_positions: self.track_positions,
            derived: self.derived.clone(),
            name_ranks: self.name_ranks.clone(),
        }
    }
}

impl TailSegment {
    pub(crate) fn new(track_positions: bool, kept: &KeptColumns) -> TailSegment {
        TailSegment {
            ids: Vec::new(),
            id_lookup: HashMap::new(),
            documents: Vec::new(),
            keyword: GrowingSegment::new(track_positions),
            field_names: Vec::new(),
            field_slots: HashMap::new(),
            columns: TailColumns::default(),
            track_positions,
            derived: DerivedColumns::kept_by(kept),
            name_ranks: Vec::new(),
        }
    }

    pub(crate) fn sorted_numbers(&self, field: &str) -> Result<Arc<SortedNumbers>> {
        let entries = self
            .columns
            .numeric
            .get(field)
            .map_or(&[][..], Vec::as_slice);
        self.derived.sorted_numbers.column(
            |held| held == field,
            || field.to_string(),
            self.len(),
            |sorted, range| {
                sorted.add_range(entries, range);
                Ok(())
            },
        )
    }

    fn keep_derived(&mut self) -> Result<()> {
        let length = self.documents.len();
        let documents = &self.documents;
        let numeric = &self.columns.numeric;
        let live_count = self.keyword.total_documents() as usize;
        self.derived
            .stored_values
            .keep(length, |path, column, range| {
                for ordinal in range {
                    column.push(path_value(&documents[ordinal], path).as_deref())?;
                }
                Ok(())
            })?;
        self.derived
            .sorted_numbers
            .keep(length, |field, sorted, range| {
                let entries = numeric.get(field).map_or(&[][..], Vec::as_slice);
                sorted.add_range(entries, range);
                Ok(())
            })?;
        self.derived
            .sort_columns
            .keep(length, |(path, mode), column, range| {
                let rebuilds = range.start == 0;
                let mut stored = CoreStoredValues::default();
                let mut values = SortValues::default();
                for (at, ordinal) in range.enumerate() {
                    stored.push(path_value(&documents[ordinal], path).as_deref())?;
                    push_reduced(&stored, at as u32, *mode, &mut values)?;
                }
                column.append(&values)?;
                match rebuilds {
                    true => column.rebuild(),
                    false => column.settle(live_count),
                }
            })
    }

    pub(crate) fn len(&self) -> usize {
        self.ids.len()
    }

    pub(crate) fn name_ranks(&self) -> &[u16] {
        &self.name_ranks
    }

    pub(crate) fn is_removed(&self, ordinal: u32) -> bool {
        self.keyword.is_retired(ordinal)
    }

    fn field_slot(&mut self, path: &str) -> u16 {
        if let Some(&slot) = self.field_slots.get(path) {
            return slot;
        }
        let slot = self.field_names.len() as u16;
        self.field_names.push(path.to_string());
        self.field_slots.insert(path.to_string(), slot);
        self.name_ranks = crate::index::fields::name_ranks(&self.field_names);
        slot
    }

    fn known_fields<'a>(&self, indexed: &'a IndexedDocument) -> Vec<SegmentFieldTokens<'a>> {
        let mut fields: Vec<SegmentFieldTokens<'a>> = indexed
            .text
            .iter()
            .filter_map(|field| {
                let slot = *self.field_slots.get(&field.path)?;
                Some(SegmentFieldTokens {
                    field: slot,
                    tokens: &field.tokens,
                })
            })
            .collect();
        fields.sort_by_key(|field| field.field);
        fields
    }

    pub(crate) fn append(
        &mut self,
        id: String,
        document: Arc<Map>,
        indexed: IndexedDocument,
    ) -> Result<Appended> {
        let ordinal = self.ids.len() as u32;
        let mut partial = Vec::new();
        for field in &indexed.text {
            let slot = self.field_slot(&field.path);
            if field.partial {
                partial.push(slot);
            }
        }
        self.keyword
            .reserve_fields(ordinal as usize + 1, self.field_names.len())?;
        for slot in partial {
            self.keyword.mark_partial(slot as usize);
        }
        let fields = self.known_fields(&indexed);
        if self.keyword.index(ordinal, &fields)? == Indexed::SegmentFull {
            return Ok(Appended::SegmentFull(indexed));
        }
        self.id_lookup.insert(id.clone(), ordinal);
        self.ids.push(id);
        self.documents.push(document);
        self.append_columns(ordinal, indexed);
        self.keep_derived().ok();
        Ok(Appended::Stored)
    }

    pub(crate) fn remove(&mut self, ordinal: u32, indexed: &IndexedDocument) -> Result<bool> {
        if ordinal as usize >= self.ids.len() || self.is_removed(ordinal) {
            return Ok(false);
        }
        let fields = self.known_fields(indexed);
        self.keyword.remove(ordinal, &fields)?;
        Ok(true)
    }

    fn append_columns(&mut self, ordinal: u32, indexed: IndexedDocument) {
        for (path, values) in indexed.numeric {
            let column = self.columns.numeric.entry(path).or_default();
            column.extend(values.into_iter().map(|value| (ordinal, value)));
        }
        for (path, size) in indexed.sizes {
            self.columns
                .sizes
                .entry(path)
                .or_default()
                .push((ordinal, size));
        }
        for (path, values) in indexed.booleans {
            let column = self.columns.booleans.entry(path).or_default();
            if values.contains(&true) {
                column.0.push(ordinal);
            }
            if values.contains(&false) {
                column.1.push(ordinal);
            }
        }
        for (path, values) in indexed.enums {
            let column = self.columns.enums.entry(path).or_default();
            for value in values {
                let documents = column.entry(value).or_default();
                if documents.last() != Some(&ordinal) {
                    documents.push(ordinal);
                }
            }
        }
        for (path, latitude, longitude) in indexed.geopoints {
            self.columns
                .geopoints
                .entry(path)
                .or_default()
                .push((ordinal, latitude, longitude));
        }
        for (path, value) in indexed.patterns {
            self.columns
                .patterns
                .entry(path)
                .or_default()
                .push((ordinal, value));
        }
    }

    pub(crate) fn ordinal_of(&self, id: &str) -> Option<u32> {
        self.id_lookup.get(id).copied()
    }

    pub(crate) fn field_length_column(&self, field: u16) -> &[u32] {
        self.keyword.field_length_column(field as usize)
    }

    pub(crate) fn field_length(&self, field: u16, ordinal: u32) -> u32 {
        self.keyword.field_length(field as usize, ordinal)
    }
}
