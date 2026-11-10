mod rows;

use std::collections::HashMap;

use super::query::PhraseRows;
use super::request::Row;
use crate::error::Result;
use crate::index::segment::{SegmentEntry, bit_is_set, set_bit};
use rows::{TokenRows, token_rows};

/// A quoted phrase after analysis: its tokens in position order, each with its distance from the first token.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AnalysedPhrase {
    pub(crate) key: String,
    pub(crate) tokens: Vec<String>,
    pub(crate) offsets: Vec<u32>,
}

/// Counts the work of a phrase match against the query's work cap, failing once the query passes it.
pub(crate) trait PhraseWork {
    fn add(&mut self, units: u64) -> Result<()>;
}

/// The documents of one segment that hold every phrase, with each phrase's rows for scoring.
pub(crate) struct PhraseMatches {
    pub(crate) matched: Vec<u32>,
    pub(crate) rows: Vec<PhraseRows>,
}

struct ResolvedPhrase<'p> {
    phrase: &'p AnalysedPhrase,
    distinct: Vec<usize>,
    entries: Vec<usize>,
    lead: usize,
    lead_offset: u32,
}

fn count_phrase_starts(
    resolved: &ResolvedPhrase<'_>,
    rows: &[TokenRows<'_>],
    lead_row: usize,
    work: &mut dyn PhraseWork,
) -> Result<u32> {
    let offsets = &resolved.phrase.offsets;
    let stores: Vec<&[u32]> = resolved
        .entries
        .iter()
        .map(|&at| rows[at].source.positions(rows[at].position_row))
        .collect();
    let mut cursors = vec![0usize; stores.len()];
    let lead = &rows[resolved.lead];
    let mut starts = 0u32;
    for &position in lead.source.positions(lead_row) {
        let Some(anchor) = position.checked_sub(resolved.lead_offset) else {
            continue;
        };
        let mut holds_every_entry = true;
        for (entry, store) in stores.iter().enumerate() {
            let wanted = anchor.saturating_add(offsets.get(entry).copied().unwrap_or(0));
            let mut cursor = cursors[entry];
            let mut compared = 1u64;
            while cursor < store.len() && store[cursor] < wanted {
                cursor += 1;
                compared += 1;
            }
            cursors[entry] = cursor;
            work.add(compared)?;
            if cursor == store.len() {
                return Ok(starts);
            }
            if store[cursor] != wanted {
                holds_every_entry = false;
                break;
            }
        }
        if holds_every_entry {
            starts += 1;
        }
    }
    Ok(starts)
}

fn collect_phrase_rows(
    entry: &SegmentEntry,
    resolved: &ResolvedPhrase<'_>,
    rows: &mut [TokenRows<'_>],
    searchable: &[u8],
    allowed: Option<&[u32]>,
    work: &mut dyn PhraseWork,
) -> Result<(Vec<u32>, PhraseRows)> {
    let mut hits = vec![0u32; entry.capacity().div_ceil(32) as usize];
    let mut collected = PhraseRows {
        key: resolved.phrase.key.clone(),
        tokens: resolved.phrase.tokens.clone(),
        rows: Vec::new(),
    };
    for &at in &resolved.distinct {
        rows[at].cursor = 0;
    }
    let lead_count = rows[resolved.lead].count();
    for lead_row in 0..lead_count {
        work.add(1)?;
        let lead = &rows[resolved.lead];
        let document = lead.source.document(lead_row);
        let field = lead.source.field(lead_row);
        if searchable.get(field as usize).copied().unwrap_or(0) == 0
            || entry.is_removed(document)
            || allowed.is_some_and(|allowed| !bit_is_set(allowed, document))
        {
            continue;
        }
        let mut holds_every_token = true;
        for &at in &resolved.distinct {
            if at == resolved.lead {
                rows[at].position_row = lead_row;
                continue;
            }
            match rows[at].position_row_for(document, field) {
                Some(row) => rows[at].position_row = row,
                None => {
                    holds_every_token = false;
                    break;
                }
            }
        }
        if !holds_every_token {
            continue;
        }
        let starts = count_phrase_starts(resolved, rows, lead_row, work)?;
        if starts == 0 {
            continue;
        }
        set_bit(&mut hits, document);
        collected.rows.push(Row {
            document,
            field,
            frequency: f64::from(starts),
        });
    }
    Ok((hits, collected))
}

/// Finds the documents of one segment that hold every phrase in a searchable field, where `filter` allows them.
///
/// Returns `None` where some phrase token is missing from the segment, so that no document of it can match.
pub(crate) fn match_phrases(
    entry: &SegmentEntry,
    phrases: &[AnalysedPhrase],
    searchable: &[u8],
    filter: Option<&[u32]>,
    work: &mut dyn PhraseWork,
) -> Result<Option<PhraseMatches>> {
    let mut rows: Vec<TokenRows<'_>> = Vec::new();
    let mut shared: HashMap<&str, usize> = HashMap::new();
    let mut resolved: Vec<ResolvedPhrase<'_>> = Vec::with_capacity(phrases.len());
    for phrase in phrases {
        let mut entries = Vec::with_capacity(phrase.tokens.len());
        let mut distinct = Vec::new();
        for token in &phrase.tokens {
            let at = match shared.get(token.as_str()) {
                Some(&at) => at,
                None => {
                    let Some(found) = token_rows(entry, token, work)? else {
                        return Ok(None);
                    };
                    rows.push(found);
                    shared.insert(token, rows.len() - 1);
                    rows.len() - 1
                }
            };
            if !distinct.contains(&at) {
                distinct.push(at);
            }
            entries.push(at);
        }
        let mut lead_entry = 0usize;
        for (entry_at, &at) in entries.iter().enumerate().skip(1) {
            if rows[at].count() < rows[entries[lead_entry]].count() {
                lead_entry = entry_at;
            }
        }
        let Some(&lead) = entries.get(lead_entry) else {
            return Ok(None);
        };
        resolved.push(ResolvedPhrase {
            phrase,
            distinct,
            entries,
            lead,
            lead_offset: phrase.offsets.get(lead_entry).copied().unwrap_or(0),
        });
    }
    resolved.sort_by_key(|phrase| rows[phrase.lead].count());
    let mut allowed: Option<Vec<u32>> = filter.map(<[u32]>::to_vec);
    let mut collected = Vec::with_capacity(resolved.len());
    for phrase in &resolved {
        let (hits, found) = collect_phrase_rows(
            entry,
            phrase,
            &mut rows,
            searchable,
            allowed.as_deref(),
            work,
        )?;
        let empty = hits.iter().all(|&word| word == 0);
        allowed = Some(hits);
        collected.push(found);
        if empty {
            break;
        }
    }
    Ok(Some(PhraseMatches {
        matched: allowed.unwrap_or_default(),
        rows: collected,
    }))
}
