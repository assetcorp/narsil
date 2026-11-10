use std::borrow::Cow;
use std::collections::HashSet;

use unicode_normalization::{IsNormalized, UnicodeNormalization, is_nfc_quick};

use super::Highlighter;
use super::snippet::{SnippetStyle, Span, snippet_of};
use crate::analysis::TokenOptions;
use crate::engine::query::javascript::utf16_length;
use crate::engine::query::results::HighlightMatch;
use crate::error::Result;
use crate::search::fuzzy::fuzzy_term_matches;

const FIELD_WORDS: TokenOptions = TokenOptions {
    stem: false,
    remove_stop_words: false,
    remove_diacritics: false,
    collect_surfaces: false,
};

const INDEXED_SPELLINGS: TokenOptions = TokenOptions {
    stem: true,
    remove_stop_words: true,
    remove_diacritics: false,
    collect_surfaces: true,
};

struct InsideMatches {
    positions: HashSet<u32>,
    spellings: HashSet<String>,
    by_spelling: bool,
}

impl InsideMatches {
    fn holds(&self, position: u32, field_token: &str) -> bool {
        match self.by_spelling {
            true => self.spellings.contains(field_token),
            false => self.positions.contains(&position),
        }
    }
}

fn lowercase_text(text: &str) -> Cow<'_, str> {
    if text.is_ascii() {
        return match text.bytes().any(|byte| byte.is_ascii_uppercase()) {
            true => Cow::Owned(text.to_ascii_lowercase()),
            false => Cow::Borrowed(text),
        };
    }
    match is_nfc_quick(text.chars()) {
        IsNormalized::Yes => Cow::Owned(text.to_lowercase()),
        _ => Cow::Owned(text.nfc().collect::<String>().to_lowercase()),
    }
}

fn token_offsets(lowered: &str, originals: &[String]) -> Vec<Span> {
    let mut spans = Vec::with_capacity(originals.len());
    let mut byte_cursor = 0;
    let mut unit_cursor = 0;
    for original in originals {
        let Some(found) = lowered[byte_cursor..].find(original.as_str()) else {
            continue;
        };
        let start = unit_cursor + utf16_length(&lowered[byte_cursor..byte_cursor + found]);
        let end = start + utf16_length(original);
        spans.push(Span { start, end });
        byte_cursor += found + original.len();
        unit_cursor = end;
    }
    spans
}

fn contains_partial_word(spelling: &str, words: &[String]) -> bool {
    let length = utf16_length(spelling);
    words
        .iter()
        .any(|word| length > utf16_length(word) && spelling.contains(word.as_str()))
}

impl Highlighter {
    fn inside_matches(&self, text: &str, words: &[String]) -> Result<InsideMatches> {
        let mut positions = HashSet::new();
        let mut spellings = HashSet::new();
        self.index_analyser.visit_tokens(
            text,
            INDEXED_SPELLINGS,
            &mut |term, position, surface, _| {
                let spelling = surface.unwrap_or(term);
                if contains_partial_word(spelling, words) {
                    positions.insert(position);
                    spellings.insert(spelling.to_string());
                }
            },
        )?;
        Ok(InsideMatches {
            positions,
            spellings,
            by_spelling: self.index_analyser.has_custom_tokenizer(),
        })
    }

    fn matches_query(&mut self, field_token: &str) -> Result<bool> {
        if let Some(&known) = self.verdicts.get(field_token) {
            return Ok(known);
        }
        let stemmed = self.field_analyser.transform(field_token, true, false)?;
        let matches = self.synonyms.contains(&stemmed)
            || self.stemmed_query.iter().any(|(query, tolerance)| {
                fuzzy_term_matches(query, &stemmed, *tolerance, self.prefix_length)
            });
        self.verdicts.insert(field_token.to_string(), matches);
        Ok(matches)
    }

    pub(super) fn highlight_through_index_analysis(
        &mut self,
        text: &str,
        field: &str,
    ) -> Result<HighlightMatch> {
        if text.is_empty() {
            return Ok(HighlightMatch::default());
        }
        let mut tokens: Vec<(String, u32)> = Vec::new();
        let mut originals: Vec<String> = Vec::new();
        self.field_analyser.visit_tokens(
            text,
            FIELD_WORDS,
            &mut |term, position, _, original| {
                tokens.push((term.to_string(), position));
                originals.push(original.to_string());
            },
        )?;
        if tokens.is_empty() {
            return Ok(HighlightMatch {
                snippet: text.to_string(),
                positions: Vec::new(),
            });
        }
        let offsets = token_offsets(&lowercase_text(text), &originals);
        let inside = match &self.partial {
            Some(partial) if partial.fields.contains(field) => {
                Some(self.inside_matches(text, &partial.words)?)
            }
            _ => None,
        };
        let mut spans = Vec::new();
        for ((token, position), offset) in tokens.iter().zip(&offsets) {
            let prefix_match = self
                .prefix_token
                .as_deref()
                .is_some_and(|prefix| token.starts_with(prefix));
            let inside_match = inside
                .as_ref()
                .is_some_and(|inside| inside.holds(*position, token));
            if prefix_match || inside_match || self.matches_query(token)? {
                spans.push(*offset);
            }
        }
        let units: Vec<u16> = text.encode_utf16().collect();
        let style = SnippetStyle {
            pre_tag: &self.core.pre_tag,
            post_tag: &self.core.post_tag,
            max_length: self.max_length,
        };
        Ok(snippet_of(&units, spans, &style))
    }
}
