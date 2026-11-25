use std::ptr;

use super::super::constants::NATIVE_FIRST_HIGHLIGHT_SPANS;
use crate::analysis::with_core_analyser;
use crate::engine::query::results::{HighlightMatch, HighlightPosition};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::native::status::refused_as;
use crate::native::workspace::with_workspace;

pub(super) struct CoreHighlightQuery {
    pub(super) terms: Vec<(Vec<u16>, u32)>,
    pub(super) prefix_length: u32,
    pub(super) prefix: Option<Vec<u16>>,
    pub(super) synonyms: Vec<Vec<u16>>,
    pub(super) partial_words: Vec<Vec<u16>>,
    pub(super) folded: Option<CoreFoldedQuery>,
    pub(super) pre_tag: Vec<u16>,
    pub(super) post_tag: Vec<u16>,
    pub(super) maximum: u32,
}

pub(super) struct CoreFoldedQuery {
    pub(super) keys: Vec<(Vec<u16>, u32)>,
    pub(super) prefix: Option<Vec<u16>>,
    pub(super) partial_words: Vec<Vec<u16>>,
}

fn terms_of(terms: &[(Vec<u16>, u32)]) -> Vec<ffi::narsil_highlight_term> {
    terms
        .iter()
        .map(|(term, tolerance)| ffi::narsil_highlight_term {
            text: text_of(term),
            tolerance: *tolerance,
        })
        .collect()
}

fn texts_of(words: &[Vec<u16>]) -> Vec<ffi::narsil_highlight_text> {
    words.iter().map(|word| text_of(word)).collect()
}

fn text_of(units: &[u16]) -> ffi::narsil_highlight_text {
    ffi::narsil_highlight_text {
        units: units.as_ptr(),
        length: units.len(),
    }
}

fn absent_text() -> ffi::narsil_highlight_text {
    ffi::narsil_highlight_text {
        units: ptr::null(),
        length: 0,
    }
}

fn highlight_refused(status: ffi::narsil_status) -> NarsilError {
    match status {
        ffi::NARSIL_INVALID_ARGUMENT => NarsilError::new(
            ErrorCode::DOC_VALIDATION_FAILED,
            "The text holds more than 1,073,741,824 UTF-16 code units, which is more than the engine highlights",
        ),
        _ => refused_as(ErrorCode::INTERNAL_ERROR, "a field's highlight", status),
    }
}

struct Output {
    snippet: Vec<u16>,
    positions: Vec<u32>,
    length: [u32; 1],
}

impl Output {
    fn sized(text_length: usize, spans: usize, tags_length: usize) -> Output {
        Output {
            snippet: vec![0; text_length + 6 + spans * tags_length],
            positions: vec![0; spans * 2],
            length: [0],
        }
    }

    fn matched(&self, count: u32) -> HighlightMatch {
        let length = (self.length[0] as usize).min(self.snippet.len());
        let positions = self
            .positions
            .as_chunks::<2>()
            .0
            .iter()
            .take(count as usize)
            .map(|pair| HighlightPosition {
                start: pair[0] as usize,
                end: pair[1] as usize,
            })
            .collect();
        HighlightMatch {
            snippet: String::from_utf16_lossy(&self.snippet[..length]),
            positions,
        }
    }
}

impl CoreHighlightQuery {
    pub(super) fn highlight(
        &self,
        language: u32,
        text: &str,
        partial_field: bool,
    ) -> Result<HighlightMatch> {
        let units: Vec<u16> = text.encode_utf16().collect();
        let terms = terms_of(&self.terms);
        let synonyms = texts_of(&self.synonyms);
        let partial_words = match partial_field {
            true => texts_of(&self.partial_words),
            false => Vec::new(),
        };
        let folded_keys = self
            .folded
            .as_ref()
            .map_or_else(Vec::new, |folded| terms_of(&folded.keys));
        let folded_partial_words = match (&self.folded, partial_field) {
            (Some(folded), true) => texts_of(&folded.partial_words),
            _ => Vec::new(),
        };
        let folded = self
            .folded
            .as_ref()
            .map(|folded| ffi::narsil_folded_highlight {
                keys: folded_keys.as_ptr(),
                key_count: folded_keys.len(),
                prefix: folded.prefix.as_deref().map_or_else(absent_text, text_of),
                partial_words: folded_partial_words.as_ptr(),
                partial_count: folded_partial_words.len(),
            });
        let request = ffi::narsil_highlight_request {
            language,
            text: text_of(&units),
            query: ffi::narsil_highlight_query {
                terms: terms.as_ptr(),
                term_count: terms.len(),
                prefix_length: self.prefix_length,
                prefix: self.prefix.as_deref().map_or_else(absent_text, text_of),
                synonyms: synonyms.as_ptr(),
                synonym_count: synonyms.len(),
                partial_words: partial_words.as_ptr(),
                partial_count: partial_words.len(),
                folded: folded.as_ref().map_or(ptr::null(), ptr::from_ref),
            },
            pre_tag: text_of(&self.pre_tag),
            post_tag: text_of(&self.post_tag),
            maximum: self.maximum,
        };
        let tags_length = self.pre_tag.len() + self.post_tag.len();
        let mut spans = units.len().min(NATIVE_FIRST_HIGHLIGHT_SPANS);
        with_core_analyser(|analyser| {
            with_workspace(|workspace| {
                loop {
                    let mut output = Output::sized(units.len(), spans, tags_length);
                    let regions = ffi::narsil_highlight_output {
                        snippet: output.snippet.as_mut_ptr(),
                        snippet_capacity: output.snippet.len(),
                        positions: output.positions.as_mut_ptr(),
                        position_words: output.positions.len(),
                        snippet_length: output.length.as_mut_ptr(),
                        length_capacity: output.length.len(),
                    };
                    let mut count = 0u32;
                    let status = unsafe {
                        ffi::narsil_highlight(analyser, workspace, &request, &regions, &mut count)
                    };
                    match status {
                        ffi::NARSIL_OK => return Ok(output.matched(count)),
                        ffi::NARSIL_NEEDS_ROOM if spans < units.len() => {
                            spans = units.len().min(spans * 2);
                        }
                        refused => return Err(highlight_refused(refused)),
                    }
                }
            })
        })
    }
}
