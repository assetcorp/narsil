use super::lookup::TermList;
use crate::error::Result;
use crate::ffi;

pub(crate) const FIELD_BOOSTS: usize = 0;
pub(crate) const FIELD_AVERAGE_LENGTHS: usize = 1;
pub(crate) const FIELD_K1: usize = 2;
pub(crate) const FIELD_B: usize = 3;

/// One row of postings that a request carries itself, because the segment's pool does not hold it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Row {
    pub(crate) document: u32,
    pub(crate) field: u16,
    pub(crate) frequency: f64,
}

/// The slots, lists, and rows of one native keyword request, which a planner fills in query term order.
#[derive(Default)]
pub(crate) struct RequestBuilder {
    pub(crate) slots: Vec<u32>,
    pub(crate) lists: Vec<u32>,
    pub(crate) list_values: Vec<f64>,
    pub(crate) slot_values: Vec<f64>,
    pub(crate) row_documents: Vec<u32>,
    pub(crate) row_frequencies: Vec<f64>,
    pub(crate) row_fields: Vec<u16>,
    pub(crate) pool_documents: Vec<u32>,
    pub(crate) pool_frequencies: Vec<u16>,
    pub(crate) pool_fields: Vec<u16>,
    pub(crate) labels: Vec<String>,
}

impl RequestBuilder {
    pub(crate) fn clear(&mut self) {
        self.slots.clear();
        self.lists.clear();
        self.list_values.clear();
        self.slot_values.clear();
        self.row_documents.clear();
        self.row_frequencies.clear();
        self.row_fields.clear();
        self.pool_documents.clear();
        self.pool_frequencies.clear();
        self.pool_fields.clear();
        self.labels.clear();
    }

    pub(crate) fn slot_count(&self) -> usize {
        self.slots.len() / ffi::NARSIL_KEYWORD_SLOT_STRIDE
    }

    pub(crate) fn list_count(&self) -> usize {
        self.lists.len() / ffi::NARSIL_KEYWORD_LIST_STRIDE
    }

    fn open_slot(&mut self, kind: u32, term: u32) {
        let lists = self.list_count() as u32;
        let values = self.slot_values.len() as u32;
        self.slots.extend_from_slice(&[kind, term, lists, values]);
    }

    fn close_slot(&mut self) {
        let lists = self.list_count() as u32;
        let values = self.slot_values.len() as u32;
        let base = self.slots.len() - ffi::NARSIL_KEYWORD_SLOT_STRIDE;
        self.slots[base + 2] = lists;
        self.slots[base + 3] = values;
    }

    pub(crate) fn term_slot(&mut self, term: u32) {
        self.open_slot(ffi::NARSIL_KEYWORD_TERM_SLOT, term);
    }

    pub(crate) fn group_slot(&mut self, term: u32, document_frequency: f64) {
        self.open_slot(ffi::NARSIL_KEYWORD_GROUP_SLOT, term);
        self.slot_values.push(document_frequency);
        self.close_slot();
    }

    pub(crate) fn phrase_slot(
        &mut self,
        document_frequencies: &[f64],
        rows: &[Row],
        label: String,
    ) {
        self.open_slot(ffi::NARSIL_KEYWORD_PHRASE_SLOT, 0);
        self.slot_values.extend_from_slice(document_frequencies);
        let ordered = rows
            .windows(2)
            .all(|pair| pair[0].document <= pair[1].document);
        self.push_rows(rows, ordered, 0.0, 0.0, label);
    }

    fn push_list(&mut self, flags: u32, start: usize, length: usize, first: f64, second: f64) {
        self.lists
            .extend_from_slice(&[flags, start as u32, length as u32]);
        self.list_values.extend_from_slice(&[first, second]);
        self.close_slot();
    }

    fn push_rows(&mut self, rows: &[Row], ordered: bool, first: f64, second: f64, label: String) {
        let start = self.row_documents.len();
        for row in rows {
            self.row_documents.push(row.document);
            self.row_fields.push(row.field);
            self.row_frequencies.push(row.frequency);
        }
        let flags = ffi::NARSIL_KEYWORD_LIST_FROM_ROWS
            | if ordered {
                ffi::NARSIL_KEYWORD_LIST_ORDERED
            } else {
                0
            };
        self.push_list(flags, start, rows.len(), first, second);
        self.labels.push(label);
    }

    /// Adds the postings of one term, with the document frequency that its score uses, copying a tail's postings
    /// and a paged segment's postings, which it reads from the segment's file, into the request's pool.
    pub(crate) fn term_list(
        &mut self,
        list: TermList<'_>,
        first: f64,
        second: f64,
        label: &str,
    ) -> Result<()> {
        match list {
            TermList::Paged { segment, token, .. } => {
                let Some(postings) = segment.paged_list(token)? else {
                    return Ok(());
                };
                let start = self.pool_documents.len();
                self.pool_documents.extend_from_slice(&postings.documents);
                self.pool_frequencies
                    .extend_from_slice(&postings.frequencies);
                self.pool_fields.extend_from_slice(&postings.fields);
                self.push_list(
                    ffi::NARSIL_KEYWORD_LIST_ORDERED,
                    start,
                    postings.len(),
                    first,
                    second,
                );
                self.labels.push(label.to_string());
            }
            TermList::Pool {
                start,
                length,
                ordered,
            } => {
                let flags = if ordered {
                    ffi::NARSIL_KEYWORD_LIST_ORDERED
                } else {
                    0
                };
                self.push_list(flags, start, length, first, second);
                self.labels.push(label.to_string());
            }
        }
        Ok(())
    }

    /// Adds rows that a search combined itself, such as a group token's postings merged with its synonyms', which
    /// the core reads as rows in no particular document order.
    pub(crate) fn row_list(&mut self, rows: &[Row], first: f64, second: f64, label: &str) {
        self.push_rows(rows, false, first, second, label.to_string());
    }
}
