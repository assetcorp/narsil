use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use super::derived::DerivedColumns;
use super::indexed::IndexedDocument;
use super::spellings::StoredSpellings;
use super::words::StoredSurfaces;
use crate::value::{Map, Value};

#[derive(Debug, Clone, Copy)]
pub(crate) struct TailPosting {
    pub(crate) document: u32,
    pub(crate) frequency: u16,
    pub(crate) field: u16,
}

#[derive(Default)]
pub(crate) struct TailTerm {
    pub(crate) postings: Vec<TailPosting>,
    pub(crate) positions: Vec<Vec<u32>>,
    pub(crate) documents: u32,
    pub(crate) total_frequency: u64,
}

#[derive(Default)]
pub(crate) struct TailColumns {
    pub(crate) numeric: BTreeMap<String, Vec<(u32, f64)>>,
    pub(crate) sizes: BTreeMap<String, Vec<(u32, f64)>>,
    pub(crate) booleans: BTreeMap<String, (Vec<u32>, Vec<u32>)>,
    pub(crate) enums: BTreeMap<String, BTreeMap<String, Vec<u32>>>,
    pub(crate) geopoints: BTreeMap<String, Vec<(u32, f64, f64)>>,
    pub(crate) patterns: BTreeMap<String, Vec<(u32, Value)>>,
}

pub(crate) struct DocumentWords {
    pub(crate) field_lengths: Vec<(u16, u32)>,
}

/// The newest documents of a partition, which the writer appends to in place while no search holds them.
#[derive(Default)]
pub(crate) struct TailSegment {
    pub(crate) ids: Vec<String>,
    pub(crate) id_lookup: HashMap<String, u32>,
    pub(crate) documents: Vec<Arc<Map>>,
    pub(crate) terms: BTreeMap<String, TailTerm>,
    pub(crate) field_names: Vec<String>,
    pub(crate) field_slots: HashMap<String, u16>,
    pub(crate) field_lengths: Vec<Vec<u32>>,
    pub(crate) words: Vec<DocumentWords>,
    pub(crate) surfaces: StoredSurfaces,
    pub(crate) document_surfaces: Vec<Vec<u32>>,
    pub(crate) spellings: StoredSpellings,
    pub(crate) columns: TailColumns,
    pub(crate) track_positions: bool,
    pub(crate) derived: DerivedColumns,
    name_ranks: Vec<u16>,
}

impl TailSegment {
    pub(crate) fn new(track_positions: bool) -> TailSegment {
        TailSegment {
            track_positions,
            ..TailSegment::default()
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.ids.len()
    }

    pub(crate) fn name_ranks(&self) -> &[u16] {
        &self.name_ranks
    }

    fn field_slot(&mut self, path: &str) -> u16 {
        if let Some(&slot) = self.field_slots.get(path) {
            return slot;
        }
        let slot = self.field_names.len() as u16;
        self.field_names.push(path.to_string());
        self.field_slots.insert(path.to_string(), slot);
        self.field_lengths.push(vec![0; self.ids.len()]);
        self.name_ranks = crate::index::fields::name_ranks(&self.field_names);
        slot
    }

    /// Appends a document and its analysis, returning its ordinal in this tail.
    pub(crate) fn append(
        &mut self,
        id: String,
        document: Arc<Map>,
        indexed: IndexedDocument,
    ) -> u32 {
        let ordinal = self.ids.len() as u32;
        self.id_lookup.insert(id.clone(), ordinal);
        self.ids.push(id);
        self.documents.push(document);
        for lengths in &mut self.field_lengths {
            lengths.push(0);
        }
        let mut field_lengths = Vec::with_capacity(indexed.text.len());
        for field in indexed.text {
            let slot = self.field_slot(&field.path);
            self.field_lengths[slot as usize][ordinal as usize] = field.length;
            field_lengths.push((slot, field.length));
            for occurrence in field.terms {
                let term = self.terms.entry(occurrence.term).or_default();
                let first_for_document = term
                    .postings
                    .last()
                    .is_none_or(|posting| posting.document != ordinal);
                if first_for_document {
                    term.documents += 1;
                }
                term.total_frequency += u64::from(occurrence.frequency);
                term.postings.push(TailPosting {
                    document: ordinal,
                    frequency: occurrence.frequency,
                    field: slot,
                });
                if self.track_positions {
                    term.positions.push(occurrence.positions);
                }
            }
        }
        let mut surface_slots = Vec::with_capacity(indexed.surfaces.len());
        for entry in &indexed.surfaces {
            surface_slots.extend(self.surfaces.add(
                &entry.surface,
                &entry.token,
                u64::from(entry.count),
            ));
        }
        self.document_surfaces.push(surface_slots);
        for entry in &indexed.spellings {
            self.spellings
                .add(&entry.spelling, &entry.token, u64::from(entry.count));
        }
        self.words.push(DocumentWords { field_lengths });
        self.append_columns(ordinal, indexed.numeric, indexed.sizes, indexed.booleans);
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
        ordinal
    }

    fn append_columns(
        &mut self,
        ordinal: u32,
        numeric: Vec<(String, Vec<f64>)>,
        sizes: Vec<(String, f64)>,
        booleans: Vec<(String, Vec<bool>)>,
    ) {
        for (path, values) in numeric {
            let column = self.columns.numeric.entry(path).or_default();
            column.extend(values.into_iter().map(|value| (ordinal, value)));
        }
        for (path, size) in sizes {
            self.columns
                .sizes
                .entry(path)
                .or_default()
                .push((ordinal, size));
        }
        for (path, values) in booleans {
            let column = self.columns.booleans.entry(path).or_default();
            if values.contains(&true) {
                column.0.push(ordinal);
            }
            if values.contains(&false) {
                column.1.push(ordinal);
            }
        }
    }

    pub(crate) fn ordinal_of(&self, id: &str) -> Option<u32> {
        self.id_lookup.get(id).copied()
    }

    pub(crate) fn field_length_column(&self, field: u16) -> &[u32] {
        self.field_lengths
            .get(field as usize)
            .map_or(&[], Vec::as_slice)
    }
}
