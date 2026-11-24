use std::collections::HashMap;

use crate::analysis::{Analyser, TokenOptions};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::search::phrase::AnalysedPhrase;
use crate::util::text::javascript_trim;
use crate::value::Value;

const MAX_PHRASE_WORDS: u32 = 32;
const MAX_QUERY_PHRASES: usize = 32;

/// A query's text split at its quotes: the words outside the quotes and the distinct phrases inside them.
pub(crate) struct QueryPhrases {
    pub(crate) words: String,
    pub(crate) phrases: Vec<AnalysedPhrase>,
    kept_phrase_count: usize,
    largest_phrase_size: u32,
    largest_token_count: u32,
    pub(crate) ends_with_phrase: bool,
}

fn is_quote(character: char) -> bool {
    matches!(character, '"' | '\u{201C}' | '\u{201D}' | '\u{201E}')
}

fn holds_quote(term: &str) -> bool {
    term.chars().any(is_quote)
}

fn positioned_tokens(analyser: &Analyser, text: &str) -> Result<Vec<(String, u32)>> {
    let mut tokens = Vec::new();
    analyser.visit_tokens(text, TokenOptions::INDEXING, &mut |term, position, _, _| {
        tokens.push((term.to_string(), position));
    })?;
    tokens.sort_by_key(|(_, position)| *position);
    Ok(tokens)
}

fn phrase_key(tokens: &[String], offsets: &[u32]) -> String {
    let mut slots: Vec<&str> = Vec::with_capacity(tokens.len());
    for (at, token) in tokens.iter().enumerate() {
        let gap = match at {
            0 => 0,
            _ => offsets[at]
                .saturating_sub(offsets[at - 1])
                .saturating_sub(1),
        };
        slots.extend(std::iter::repeat_n("?", gap as usize));
        slots.push(token);
    }
    format!("\"{}\"", slots.join(" "))
}

fn written_words(
    analyser: &Analyser,
    text: &str,
    entries: &[(String, u32)],
) -> Result<Vec<String>> {
    let options = TokenOptions {
        stem: false,
        ..TokenOptions::INDEXING
    };
    let mut written: HashMap<u32, String> = HashMap::new();
    analyser.visit_tokens(text, options, &mut |term, position, _, _| {
        written.insert(position, term.to_string());
    })?;
    Ok(entries
        .iter()
        .map(|(token, position)| written.get(position).unwrap_or(token).clone())
        .collect())
}

/// Splits `term` at its quotes and analyses each phrase, or returns `None` where `term` holds no quote.
pub(crate) fn analyse_query_phrases(
    analyser: &Analyser,
    term: &str,
) -> Result<Option<QueryPhrases>> {
    analyse_phrases(analyser, term, false)
}

/// Splits `term` at its quotes as [`analyse_query_phrases`] does, and keeps each phrase token's word as written
/// where `folds` is set, which folded matching finds the token's variants from.
pub(crate) fn analyse_phrases(
    analyser: &Analyser,
    term: &str,
    folds: bool,
) -> Result<Option<QueryPhrases>> {
    if !holds_quote(term) {
        return Ok(None);
    }
    let mut word_parts: Vec<&str> = Vec::new();
    let mut phrases: Vec<AnalysedPhrase> = Vec::new();
    let mut kept_phrase_count = 0usize;
    let mut largest_phrase_size = 0u32;
    let mut largest_token_count = 0u32;
    let mut words_after_last_phrase = String::new();
    for (index, part) in term.split(is_quote).enumerate() {
        if index % 2 == 0 {
            word_parts.push(part);
            words_after_last_phrase.push(' ');
            words_after_last_phrase.push_str(part);
            continue;
        }
        if javascript_trim(part).is_empty() {
            continue;
        }
        let entries = positioned_tokens(analyser, part)?;
        let (Some(first), Some(last)) = (entries.first(), entries.last()) else {
            continue;
        };
        let first_position = first.1;
        let size = last.1.saturating_sub(first_position).saturating_add(1);
        kept_phrase_count += 1;
        words_after_last_phrase.clear();
        largest_phrase_size = largest_phrase_size.max(size);
        largest_token_count = largest_token_count.max(entries.len().min(u32::MAX as usize) as u32);
        let offsets: Vec<u32> = entries
            .iter()
            .map(|(_, position)| position - first_position)
            .collect();
        let written = match folds {
            true => written_words(analyser, part, &entries)?,
            false => Vec::new(),
        };
        let tokens: Vec<String> = entries.into_iter().map(|(token, _)| token).collect();
        if phrases
            .iter()
            .any(|held| held.tokens == tokens && held.offsets == offsets)
        {
            continue;
        }
        phrases.push(AnalysedPhrase {
            key: phrase_key(&tokens, &offsets),
            tokens,
            offsets,
            written,
            variants: Vec::new(),
        });
    }
    let ends_with_phrase = kept_phrase_count > 0
        && (javascript_trim(&words_after_last_phrase).is_empty()
            || positioned_tokens(analyser, &words_after_last_phrase)?.is_empty());
    Ok(Some(QueryPhrases {
        words: word_parts.join(" "),
        phrases,
        kept_phrase_count,
        largest_phrase_size,
        largest_token_count,
        ends_with_phrase,
    }))
}

/// Refuses a query whose term holds a phrase that passes a limit, or a phrase that an index without word positions
/// cannot match.
pub(crate) fn require_usable_phrases(
    analyser: &Analyser,
    term: Option<&str>,
    track_positions: bool,
) -> Result<()> {
    let Some(term) = term else {
        return Ok(());
    };
    match analyse_query_phrases(analyser, term)? {
        Some(quoted) => require_phrases_within_limits(&quoted, track_positions),
        None => Ok(()),
    }
}

fn require_phrases_within_limits(phrases: &QueryPhrases, track_positions: bool) -> Result<()> {
    if phrases.kept_phrase_count == 0 {
        return Ok(());
    }
    if phrases.kept_phrase_count > MAX_QUERY_PHRASES {
        return Err(NarsilError::new(
            ErrorCode::SEARCH_INVALID_PHRASE,
            format!(
                "A query takes at most {MAX_QUERY_PHRASES} phrases, while this query holds {}",
                phrases.kept_phrase_count
            ),
        )
        .with_details([
            ("limit", Value::from(MAX_QUERY_PHRASES)),
            ("phrases", Value::from(phrases.kept_phrase_count)),
        ]));
    }
    let largest = phrases.largest_phrase_size.max(phrases.largest_token_count);
    if largest > MAX_PHRASE_WORDS {
        return Err(NarsilError::new(
            ErrorCode::SEARCH_INVALID_PHRASE,
            format!(
                "A phrase takes at most {MAX_PHRASE_WORDS} words, counting the stop words between its first and last word, while this query holds one of {largest}"
            ),
        )
        .with_details([
            ("limit", Value::from(MAX_PHRASE_WORDS)),
            ("words", Value::from(largest)),
        ]));
    }
    if !track_positions {
        return Err(NarsilError::new(
            ErrorCode::SEARCH_INVALID_PHRASE,
            "This index stores no word positions because its trackPositions setting is off, so it cannot match a phrase. Remove the quotes, or create the index with trackPositions on",
        )
        .with_details([("trackPositions", Value::from(false))]));
    }
    Ok(())
}
