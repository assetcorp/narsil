use super::partial::PartialWordRequest;
use super::{ExpansionSources, expansion_rows, units};
use crate::error::Result;
use crate::ffi;
use crate::index::segment::SegmentData;
use crate::keyword::constants::{EXPANSION_START_CAPACITY, MAX_ROOM_ATTEMPTS};
use crate::keyword::fold_table::{FoldTableCell, HeldFoldTables, hold_fold_tables};
use crate::native::status::core_refused;
use crate::native::workspace::with_workspace;

/// One query term that folded matching widens: the key of the term as written, its token, the synonyms that its
/// group already scores, and the typo settings that its typo matches take.
pub(crate) struct FoldedWordRequest {
    pub(crate) key: String,
    pub(crate) own: String,
    pub(crate) excluded: Vec<String>,
    pub(crate) tolerance: u32,
    pub(crate) prefix_length: u32,
}

/// The variants of one query term and the typo matches that its unmarked form adds, each in code point order.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct FoldedTerm {
    pub(crate) variants: Vec<String>,
    pub(crate) typo_matches: Vec<String>,
}

struct WordUnits {
    key: Vec<u16>,
    own: Vec<u16>,
    excluded: Vec<Vec<u16>>,
}

const BLOCKS_PER_WORD: usize = 2;

impl ExpansionSources<'_> {
    fn fold_cells(&self) -> Vec<&FoldTableCell> {
        self.entries
            .iter()
            .map(|entry| match &entry.data {
                SegmentData::Frozen(segment) => &segment.folds,
                SegmentData::Tail(tail) => &tail.folds,
            })
            .collect()
    }

    fn held_fold_tables(&self, language: u32) -> Result<HeldFoldTables<'_>> {
        hold_fold_tables(&self.fold_cells(), &self.segments, language)
    }

    /// Returns the variants and the folded typo matches of each word, in the order of `words`.
    pub(crate) fn folded_terms(
        &self,
        language: u32,
        words: &[FoldedWordRequest],
    ) -> Result<Vec<FoldedTerm>> {
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let tables = self.held_fold_tables(language)?;
        let texts: Vec<WordUnits> = words
            .iter()
            .map(|word| WordUnits {
                key: units(&word.key),
                own: units(&word.own),
                excluded: word.excluded.iter().map(|token| units(token)).collect(),
            })
            .collect();
        let excluded: Vec<Vec<ffi::narsil_term>> = texts
            .iter()
            .map(|text| {
                text.excluded
                    .iter()
                    .map(|token| ffi::narsil_term {
                        units: token.as_ptr(),
                        length: token.len() as u32,
                    })
                    .collect()
            })
            .collect();
        let raw: Vec<ffi::narsil_folded_word> = words
            .iter()
            .zip(&texts)
            .zip(&excluded)
            .map(|((word, text), excluded)| ffi::narsil_folded_word {
                key: text.key.as_ptr(),
                key_length: text.key.len(),
                own: text.own.as_ptr(),
                own_length: text.own.len(),
                excluded: excluded.as_ptr(),
                excluded_count: excluded.len(),
                tolerance: word.tolerance,
                prefix_length: word.prefix_length,
            })
            .collect();
        let (segments, segment_count) = self.segments();
        let request = ffi::narsil_folded_request {
            segments,
            tables: tables.pointers(),
            segment_count,
            words: raw.as_ptr(),
            word_count: raw.len(),
        };
        let mut starts = vec![0u32; words.len() * BLOCKS_PER_WORD + 1];
        let mut capacity = EXPANSION_START_CAPACITY;
        for _ in 0..MAX_ROOM_ATTEMPTS {
            let mut row_segments = vec![0u32; capacity];
            let mut row_tokens = vec![0u32; capacity];
            let output = ffi::narsil_folded_output {
                segments: row_segments.as_mut_ptr(),
                segment_capacity: capacity,
                tokens: row_tokens.as_mut_ptr(),
                token_capacity: capacity,
                starts: starts.as_mut_ptr(),
                start_capacity: starts.len(),
            };
            let mut count = 0u32;
            let status = with_workspace(|workspace| {
                Ok(unsafe {
                    ffi::narsil_expand_folded_terms(workspace, &request, &output, &mut count)
                })
            })?;
            match status {
                ffi::NARSIL_OK => {
                    let count = count as usize;
                    let token_at = |at: usize| -> Result<String> {
                        self.token(row_segments[at], row_tokens[at])
                    };
                    let block = |from: u32, to: u32| -> Result<Vec<String>> {
                        (from as usize..(to as usize).min(count))
                            .map(token_at)
                            .collect()
                    };
                    return (0..words.len())
                        .map(|word| {
                            let at = word * BLOCKS_PER_WORD;
                            Ok(FoldedTerm {
                                variants: block(starts[at], starts[at + 1])?,
                                typo_matches: block(starts[at + 1], starts[at + 2])?,
                            })
                        })
                        .collect();
                }
                ffi::NARSIL_NEEDS_ROOM => capacity *= 2,
                status => return Err(core_refused("a folded term expansion", status)),
            }
        }
        Err(core_refused(
            "a folded term expansion",
            ffi::NARSIL_NEEDS_ROOM,
        ))
    }

    /// Returns the completions of the last word, together with those that its fold reaches.
    pub(crate) fn complete_folded_prefix(
        &self,
        language: u32,
        typed: &str,
        stemmed: &str,
        folded: &str,
    ) -> Result<Vec<(String, f64)>> {
        let tables = self.held_fold_tables(language)?;
        let typed = units(typed);
        let own = units(stemmed);
        let folded = units(folded);
        let (segments, segment_count) = self.segments();
        let request = ffi::narsil_folded_prefix_request {
            prefix: ffi::narsil_prefix_request {
                segments,
                segment_count,
                typed: typed.as_ptr(),
                typed_length: typed.len(),
                stemmed: own.as_ptr(),
                stemmed_length: own.len(),
                own: own.as_ptr(),
                own_length: own.len(),
            },
            tables: tables.pointers(),
            folded: folded.as_ptr(),
            folded_length: folded.len(),
        };
        let rows = expansion_rows(
            "a folded prefix completion",
            |workspace, output, count| unsafe {
                ffi::narsil_expand_folded_prefix(workspace, &request, &output, count)
            },
        )?;
        (0..rows.count)
            .map(|at| self.expansion(&rows, at))
            .collect()
    }

    /// Returns the words that each request adds, where each request also matches through the fold of its word.
    pub(crate) fn folded_partial_additions(
        &self,
        language: u32,
        requests: &[PartialWordRequest],
        folded: &[String],
    ) -> Result<Vec<Vec<(String, f64)>>> {
        let tables = self.held_fold_tables(language)?;
        let folded_units: Vec<Vec<u16>> = folded.iter().map(|text| units(text)).collect();
        let probes: Vec<ffi::narsil_term> = folded_units
            .iter()
            .map(|text| ffi::narsil_term {
                units: text.as_ptr(),
                length: text.len() as u32,
            })
            .collect();
        self.expand_partial(requests, &mut |workspace, request, output, count| {
            let folded_request = ffi::narsil_folded_partial_request {
                partial: ffi::narsil_partial_request {
                    segments: request.segments,
                    runs: request.runs,
                    segment_count: request.segment_count,
                    words: request.words,
                    word_count: request.word_count,
                },
                tables: tables.pointers(),
                folded: probes.as_ptr(),
            };
            unsafe {
                ffi::narsil_expand_folded_partial_words(workspace, &folded_request, output, count)
            }
        })
    }
}
