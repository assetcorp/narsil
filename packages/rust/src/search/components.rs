use std::collections::HashMap;

use super::core_call::{FieldScoring, Pool};
use super::math::{bm25, idf};
use super::request::{FIELD_AVERAGE_LENGTHS, FIELD_B, FIELD_BOOSTS, FIELD_K1, RequestBuilder};
use crate::ffi;
use crate::index::segment::bit_is_set;

const UNKNOWN_FIELD_RANK: u32 = 0x10000;

/// What a document's score was made from: each term's frequency per field, each field's length, and each term's
/// inverse document frequency, keyed the way the engine reports them.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ScoreComponents {
    pub(crate) term_frequencies: Vec<(String, f64)>,
    pub(crate) field_lengths: Vec<(String, f64)>,
    pub(crate) idf: Vec<(String, f64)>,
}

fn put(entries: &mut Vec<(String, f64)>, key: String, value: f64) {
    match entries.iter_mut().find(|(held, _)| *held == key) {
        Some(entry) => entry.1 = value,
        None => entries.push((key, value)),
    }
}

/// The parts of one scored request that the components pass reads again.
pub(crate) struct ComponentSource<'a> {
    pub(crate) builder: &'a RequestBuilder,
    pub(crate) pool: Pool<'a>,
    pub(crate) fields: &'a FieldScoring<'a>,
    pub(crate) names: &'a [String],
    pub(crate) filter: Option<&'a [u32]>,
    pub(crate) removed: &'a [u32],
    pub(crate) total_documents: f64,
}

struct ListRows {
    from_rows: bool,
    by_document: Vec<(u32, Vec<usize>)>,
}

struct Winner {
    sum: f64,
    rows: Vec<usize>,
    list: usize,
    from_rows: bool,
}

impl ComponentSource<'_> {
    fn scorable(&self, ordinal: u32) -> bool {
        !bit_is_set(self.removed, ordinal)
            && self.filter.is_none_or(|bits| bit_is_set(bits, ordinal))
    }

    fn list_word(&self, list: usize, word: usize) -> usize {
        self.builder.lists[list * ffi::NARSIL_KEYWORD_LIST_STRIDE + word] as usize
    }

    fn document_of(&self, from_rows: bool, row: usize) -> u32 {
        let documents = if from_rows {
            &self.builder.row_documents[..]
        } else {
            self.pool.documents
        };
        documents.get(row).copied().unwrap_or(u32::MAX)
    }

    fn field_of(&self, from_rows: bool, row: usize) -> usize {
        let fields = if from_rows {
            &self.builder.row_fields[..]
        } else {
            self.pool.fields
        };
        fields.get(row).map_or(usize::MAX, |&field| field as usize)
    }

    fn frequency_of(&self, from_rows: bool, row: usize) -> f64 {
        if from_rows {
            self.builder
                .row_frequencies
                .get(row)
                .copied()
                .unwrap_or(0.0)
        } else {
            self.pool
                .frequencies
                .get(row)
                .map_or(0.0, |&frequency| f64::from(frequency))
        }
    }

    fn rank_of(&self, from_rows: bool, row: usize) -> u32 {
        let field = self.field_of(from_rows, row);
        self.fields
            .name_ranks
            .get(field)
            .map_or(UNKNOWN_FIELD_RANK, |&rank| u32::from(rank))
    }

    fn rows_of_list(&self, list: usize, wanted: &HashMap<u32, ()>) -> ListRows {
        let flags = self.list_word(list, 0) as u32;
        let start = self.list_word(list, 1);
        let length = self.list_word(list, 2);
        let from_rows = flags & ffi::NARSIL_KEYWORD_LIST_FROM_ROWS != 0;
        let mut at_of: HashMap<u32, usize> = HashMap::new();
        let mut by_document: Vec<(u32, Vec<usize>)> = Vec::new();
        for row in start..start + length {
            let ordinal = self.document_of(from_rows, row);
            if !wanted.contains_key(&ordinal) {
                continue;
            }
            match at_of.get(&ordinal) {
                Some(&at) => by_document[at].1.push(row),
                None => {
                    at_of.insert(ordinal, by_document.len());
                    by_document.push((ordinal, vec![row]));
                }
            }
        }
        for (_, rows) in &mut by_document {
            rows.sort_by_key(|&row| self.rank_of(from_rows, row));
        }
        ListRows {
            from_rows,
            by_document,
        }
    }

    fn numbers(&self, column: usize, field: usize) -> f64 {
        let count = self.fields.searchable.len();
        self.fields
            .numbers
            .get(column * count + field)
            .copied()
            .unwrap_or(0.0)
    }

    fn length_in(&self, field: usize, ordinal: u32) -> f64 {
        let average = self.numbers(FIELD_AVERAGE_LENGTHS, field);
        let stored = self
            .fields
            .lengths
            .get(field)
            .and_then(|column| column.get(ordinal as usize).copied())
            .unwrap_or(0);
        if stored > 0 {
            f64::from(stored)
        } else {
            average
        }
    }

    fn row_score(&self, frequency: f64, idf: f64, field: usize, ordinal: u32) -> f64 {
        let score = bm25(
            frequency,
            idf,
            self.length_in(field, ordinal),
            self.numbers(FIELD_AVERAGE_LENGTHS, field),
            self.numbers(FIELD_K1, field),
            self.numbers(FIELD_B, field),
        );
        score * self.numbers(FIELD_BOOSTS, field)
    }

    fn searchable(&self, field: usize) -> bool {
        self.fields
            .searchable
            .get(field)
            .is_some_and(|&mark| mark != 0)
    }

    fn record(
        &self,
        found: &mut HashMap<u32, ScoreComponents>,
        source: (bool, &[usize]),
        ordinal: u32,
        label: &str,
        term_idf: f64,
    ) {
        let (from_rows, rows) = source;
        for &row in rows {
            let field = self.field_of(from_rows, row);
            if !self.searchable(field) {
                continue;
            }
            let Some(name) = self.names.get(field) else {
                continue;
            };
            let components = found.entry(ordinal).or_default();
            put(
                &mut components.term_frequencies,
                format!("{name}:{label}"),
                self.frequency_of(from_rows, row),
            );
            put(
                &mut components.field_lengths,
                name.clone(),
                self.length_in(field, ordinal),
            );
            put(&mut components.idf, label.to_string(), term_idf);
        }
    }

    fn group_winners(
        &self,
        wanted: &HashMap<u32, ()>,
        lists: std::ops::Range<usize>,
        term_idf: f64,
    ) -> Vec<(u32, Winner)> {
        let mut winners: Vec<(u32, Winner)> = Vec::new();
        let mut at_of: HashMap<u32, usize> = HashMap::new();
        for list in lists {
            let factor = self.builder.list_values[list * ffi::NARSIL_KEYWORD_LIST_VALUE_STRIDE];
            let partial_factor =
                self.builder.list_values[list * ffi::NARSIL_KEYWORD_LIST_VALUE_STRIDE + 1];
            let source = self.rows_of_list(list, wanted);
            for (ordinal, rows) in source.by_document {
                if !self.scorable(ordinal) {
                    continue;
                }
                let mut sum = 0.0;
                let mut kept = Vec::new();
                for row in rows {
                    let field = self.field_of(source.from_rows, row);
                    if !self.searchable(field) {
                        continue;
                    }
                    let partial = self.fields.partial_marks.get(field) == Some(&1);
                    let row_factor = if partial { partial_factor } else { factor };
                    if row_factor.is_nan() || row_factor <= 0.0 {
                        continue;
                    }
                    sum += self.row_score(
                        self.frequency_of(source.from_rows, row),
                        term_idf,
                        field,
                        ordinal,
                    ) * row_factor;
                    kept.push(row);
                }
                if kept.is_empty() {
                    continue;
                }
                let winner = Winner {
                    sum,
                    rows: kept,
                    list,
                    from_rows: source.from_rows,
                };
                match at_of.get(&ordinal) {
                    Some(&at) if sum > winners[at].1.sum => winners[at].1 = winner,
                    Some(_) => {}
                    None => {
                        at_of.insert(ordinal, winners.len());
                        winners.push((ordinal, winner));
                    }
                }
            }
        }
        winners
    }

    /// Returns the score components of each of `ordinals`, read from the request that scored them.
    pub(crate) fn components(&self, ordinals: &[u32]) -> HashMap<u32, ScoreComponents> {
        let wanted: HashMap<u32, ()> = ordinals.iter().map(|&ordinal| (ordinal, ())).collect();
        let mut found: HashMap<u32, ScoreComponents> = HashMap::new();
        let builder = self.builder;
        let mut list_from = 0usize;
        let mut value_from = 0usize;
        for slot in builder.slots.chunks_exact(ffi::NARSIL_KEYWORD_SLOT_STRIDE) {
            let (kind, list_end, value_end) = (slot[0], slot[2] as usize, slot[3] as usize);
            let values = builder
                .slot_values
                .get(value_from..value_end)
                .unwrap_or(&[]);
            if kind == ffi::NARSIL_KEYWORD_GROUP_SLOT {
                let term_idf = idf(values.first().copied().unwrap_or(0.0), self.total_documents);
                for (ordinal, winner) in self.group_winners(&wanted, list_from..list_end, term_idf)
                {
                    let label = builder.labels.get(winner.list).map_or("", String::as_str);
                    self.record(
                        &mut found,
                        (winner.from_rows, &winner.rows),
                        ordinal,
                        label,
                        term_idf,
                    );
                }
            } else {
                let phrase_idf = values.iter().fold(0.0, |total, &value| {
                    total + idf(value, self.total_documents)
                });
                for list in list_from..list_end {
                    let term_idf = if kind == ffi::NARSIL_KEYWORD_PHRASE_SLOT {
                        phrase_idf
                    } else {
                        idf(
                            builder.list_values[list * ffi::NARSIL_KEYWORD_LIST_VALUE_STRIDE],
                            self.total_documents,
                        )
                    };
                    let label = builder.labels.get(list).map_or("", String::as_str);
                    let source = self.rows_of_list(list, &wanted);
                    for (ordinal, rows) in &source.by_document {
                        if self.scorable(*ordinal) {
                            self.record(
                                &mut found,
                                (source.from_rows, rows),
                                *ordinal,
                                label,
                                term_idf,
                            );
                        }
                    }
                }
            }
            list_from = list_end;
            value_from = value_end;
        }
        found
    }
}
