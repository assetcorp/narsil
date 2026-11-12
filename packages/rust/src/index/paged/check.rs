use super::PagedSections;
use super::lists::PostingList;
use crate::error::{Result, load_failed};
use crate::format::keyword_segment::KeywordSegment;
use crate::format::paged_segment::write_lists::{Row, block_summaries};
use crate::format::paged_segment::{BLOCK_SUMMARY_BYTES, SMALLEST_BLOCK_POSTINGS};
use crate::util::bytes::le_values;

struct StoredBlocks {
    lists: Vec<u32>,
    offsets: Vec<u32>,
    summaries: Vec<u8>,
}

impl StoredBlocks {
    fn summaries_of(&self, listed: usize) -> &[u8] {
        let first = self.offsets[listed] as usize * BLOCK_SUMMARY_BYTES;
        let end = self.offsets[listed + 1] as usize * BLOCK_SUMMARY_BYTES;
        &self.summaries[first..end]
    }
}

struct TokenCounts {
    documents: u32,
    occurrences: f64,
}

impl PagedSections {
    fn stored_blocks(&self) -> Result<StoredBlocks> {
        let lists = self.file.whole_checked(&self.block_lists)?;
        let offsets = self.file.whole_checked(&self.block_list_offsets)?;
        Ok(StoredBlocks {
            lists: le_values(&lists, u32::from_le_bytes).collect(),
            offsets: le_values(&offsets, u32::from_le_bytes).collect(),
            summaries: self.file.whole_checked(&self.block_summaries)?,
        })
    }

    fn rows_of(&self, token: usize, list: &PostingList) -> Result<(Vec<Row>, TokenCounts)> {
        let mut rows = Vec::with_capacity(list.len());
        let mut counts = TokenCounts {
            documents: 0,
            occurrences: 0.0,
        };
        for at in 0..list.len() {
            let (document, field) = (list.documents[at], list.fields[at]);
            if document >= self.document_count {
                return load_failed(format!(
                    "Token {token} of \"{}\" names document {document} of {}",
                    self.key, self.document_count
                ));
            }
            if usize::from(field) >= self.field_count {
                return load_failed(format!(
                    "Token {token} of \"{}\" names field {field} of {}",
                    self.key, self.field_count
                ));
            }
            if let Some(before) = rows.last().map(|row: &Row| (row.document, row.field)) {
                if (document, field) <= before {
                    return load_failed(format!(
                        "The list of token {token} of \"{}\" descends at posting {at}",
                        self.key
                    ));
                }
                if document != before.0 {
                    counts.documents += 1;
                }
            } else {
                counts.documents = 1;
            }
            counts.occurrences += f64::from(list.frequencies[at]);
            rows.push(Row {
                document,
                frequency: list.frequencies[at],
                field,
                posting: at,
            });
        }
        Ok((rows, counts))
    }

    /// Reads every token's postings, positions, and total from the file, and fails with
    /// `PERSISTENCE_LOAD_FAILED` unless each list names documents and fields that the segment holds in ascending
    /// order, its distinct documents and occurrences match the token's document frequency and total, and the
    /// stored block summaries of a list longer than `SMALLEST_BLOCK_POSTINGS` match the blocks that its postings
    /// make. `resident` is the keyword segment that [`super::open_paged_segment`] returned beside these sections.
    pub(crate) fn require_postings_match(&self, resident: &KeywordSegment) -> Result<()> {
        let stored = self.stored_blocks()?;
        let columns = resident.length_columns();
        let mut listed = 0usize;
        let mut expected = Vec::new();
        let mut total = [0f64];
        for token in 0..resident.token_count() {
            let start = resident.posting_offsets[token];
            let count = resident.posting_offsets[token + 1] - start;
            let list = self.list(token, start, count)?;
            self.positions(token, start, count)?;
            let (rows, counts) = self.rows_of(token, &list)?;
            let blocked = stored.lists.get(listed) == Some(&(token as u32));
            if (rows.len() > SMALLEST_BLOCK_POSTINGS) != blocked {
                return load_failed(format!(
                    "The block summaries of token {token} of \"{}\" do not cover its postings",
                    self.key
                ));
            }
            if blocked {
                expected.clear();
                block_summaries(&rows, &columns, &mut expected)?;
                if expected.as_slice() != stored.summaries_of(listed) {
                    return load_failed(format!(
                        "The block summaries of token {token} of \"{}\" differ from its postings",
                        self.key
                    ));
                }
                listed += 1;
            }
            self.totals(token as u32, &mut total)?;
            if counts.documents != resident.document_frequencies[token]
                || counts.occurrences != total[0]
            {
                return load_failed(format!(
                    "The counts of token {token} of \"{}\" differ from its postings",
                    self.key
                ));
            }
        }
        Ok(())
    }
}
