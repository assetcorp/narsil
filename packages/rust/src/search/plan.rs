use std::collections::BTreeMap;

use super::core_call::{FieldScoring, Pool};
use super::lookup::{TermList, lookup};
use super::query::{KeywordQuery, PhraseRows, TermGroup};
use super::request::{FIELD_AVERAGE_LENGTHS, FIELD_B, FIELD_BOOSTS, FIELD_K1, RequestBuilder, Row};
use super::stats::{QueryStats, typo_tokens_for};
use crate::config::{DEFAULT_BM25_B, DEFAULT_BM25_K1};
use crate::error::Result;
use crate::ffi;
use crate::index::segment::{SegmentData, SegmentEntry};

const EMPTY_POOL: Pool<'static> = Pool {
    documents: &[],
    frequencies: &[],
    fields: &[],
};

pub(crate) fn segment_pool(entry: &SegmentEntry) -> Option<Pool<'_>> {
    match &entry.data {
        SegmentData::Frozen(segment) if segment.paged.is_some() => None,
        SegmentData::Frozen(segment) => Some(Pool {
            documents: &segment.payload.posting_documents,
            frequencies: &segment.payload.posting_frequencies,
            fields: &segment.payload.posting_fields,
        }),
        SegmentData::Tail(tail) => {
            let postings = &tail.keyword.postings;
            Some(Pool {
                documents: &postings.doc_ids,
                frequencies: &postings.frequencies,
                fields: &postings.field_indices,
            })
        }
    }
}

pub(crate) fn request_pool<'a>(entry: &'a SegmentEntry, builder: &'a RequestBuilder) -> Pool<'a> {
    segment_pool(entry).unwrap_or(Pool {
        documents: &builder.pool_documents,
        frequencies: &builder.pool_frequencies,
        fields: &builder.pool_fields,
    })
}

/// Returns the names of the segment's fields, in the order that its postings number them.
pub(crate) fn field_names(entry: &SegmentEntry) -> &[String] {
    match &entry.data {
        SegmentData::Frozen(segment) => segment.field_names(),
        SegmentData::Tail(tail) => &tail.field_names,
    }
}

fn field_pair(query: &KeywordQuery<'_>, name: &str) -> (f64, f64) {
    let k1 = query.bm25.k1.unwrap_or(DEFAULT_BM25_K1);
    let b = query.bm25.b.unwrap_or(DEFAULT_BM25_B);
    let pair = query
        .bm25
        .fields
        .iter()
        .flatten()
        .find(|(field, _)| field == name)
        .map(|(_, pair)| pair);
    (
        pair.and_then(|pair| pair.k1).unwrap_or(k1),
        pair.and_then(|pair| pair.b).unwrap_or(b),
    )
}

/// Returns the per-field numbers of the segment's field table for one query.
pub(crate) fn field_scoring<'a>(
    entry: &'a SegmentEntry,
    query: &KeywordQuery<'_>,
    stats: &QueryStats,
) -> FieldScoring<'a> {
    let names = field_names(entry);
    let count = names.len();
    let mut numbers = vec![0.0; count * ffi::NARSIL_KEYWORD_FIELD_NUMBER_COLUMNS];
    let mut searchable = Vec::with_capacity(count);
    let mut partial_marks = Vec::with_capacity(count);
    let mut lengths = Vec::with_capacity(count);
    for (field, name) in names.iter().enumerate() {
        searchable.push(u8::from(
            query.fields.is_none_or(|fields| fields.contains(name)),
        ));
        partial_marks.push(u8::from(query.partial_fields.contains(name)));
        let boost = query
            .boost
            .iter()
            .find(|(held, _)| held == name)
            .map_or(1.0, |(_, boost)| *boost);
        let (k1, b) = field_pair(query, name);
        numbers[FIELD_BOOSTS * count + field] = boost;
        numbers[FIELD_AVERAGE_LENGTHS * count + field] = stats.average(name);
        numbers[FIELD_K1 * count + field] = k1;
        numbers[FIELD_B * count + field] = b;
        lengths.push(match &entry.data {
            SegmentData::Frozen(segment) => segment.field_length_column(field as u16),
            SegmentData::Tail(tail) => tail.field_length_column(field as u16),
        });
    }
    let name_ranks = match &entry.data {
        SegmentData::Frozen(segment) => segment.name_ranks(),
        SegmentData::Tail(tail) => tail.name_ranks(),
    };
    FieldScoring {
        searchable,
        partial_marks,
        name_ranks,
        numbers,
        lengths,
    }
}

fn rows_of(entry: &SegmentEntry, list: TermList<'_>) -> Result<Vec<Row>> {
    match list {
        TermList::Pool { start, length, .. } => {
            let pool = segment_pool(entry).unwrap_or(EMPTY_POOL);
            Ok((start..start + length)
                .filter_map(|row| {
                    Some(Row {
                        document: *pool.documents.get(row)?,
                        field: *pool.fields.get(row)?,
                        frequency: f64::from(*pool.frequencies.get(row)?),
                    })
                })
                .collect())
        }
        TermList::Paged { segment, token, .. } => {
            let Some(postings) = segment.paged_list(token)? else {
                return Ok(Vec::new());
            };
            Ok(postings
                .documents
                .iter()
                .zip(&postings.fields)
                .zip(&postings.frequencies)
                .map(|((&document, &field), &frequency)| Row {
                    document,
                    field,
                    frequency: f64::from(frequency),
                })
                .collect())
        }
    }
}

fn combined_rows(entry: &SegmentEntry, lists: &[TermList<'_>]) -> Result<Vec<Row>> {
    let mut by_document: BTreeMap<u32, Vec<Row>> = BTreeMap::new();
    for &list in lists {
        for row in rows_of(entry, list)? {
            if entry.is_removed(row.document) {
                continue;
            }
            let rows = by_document.entry(row.document).or_default();
            match rows.iter_mut().find(|held| held.field == row.field) {
                Some(held) => held.frequency += row.frequency,
                None => rows.push(row),
            }
        }
    }
    Ok(by_document.into_values().flatten().collect())
}

fn plan_group(
    entry: &SegmentEntry,
    stats: &QueryStats,
    builder: &mut RequestBuilder,
    group: &TermGroup,
    term: u32,
) -> Result<()> {
    let mut document_frequency = group
        .synonyms
        .iter()
        .flatten()
        .fold(0.0, |most: f64, token| most.max(stats.frequency(token)));
    for member in &group.members {
        document_frequency = document_frequency.max(stats.frequency(&member.token));
    }
    builder.group_slot(term, document_frequency);
    for member in &group.members {
        let synonyms = group
            .synonyms
            .as_deref()
            .filter(|_| member.token == group.token);
        let Some(synonyms) = synonyms else {
            if let Some(list) = lookup(entry, &member.token)? {
                builder.term_list(list, member.factor, member.partial_factor, &member.token)?;
            }
            continue;
        };
        let mut lists: Vec<TermList<'_>> = Vec::new();
        for token in
            std::iter::once(member.token.as_str()).chain(synonyms.iter().map(String::as_str))
        {
            lists.extend(lookup(entry, token)?);
        }
        match lists.as_slice() {
            [] => {}
            [list] => {
                builder.term_list(*list, member.factor, member.partial_factor, &member.token)?
            }
            _ => builder.row_list(
                &combined_rows(entry, &lists)?,
                member.factor,
                member.partial_factor,
                &member.token,
            ),
        }
    }
    Ok(())
}

/// Fills `builder` with the slots of one segment's request, in the order that every Narsil implementation uses.
pub(crate) fn plan_segment(
    entry: &SegmentEntry,
    query: &KeywordQuery<'_>,
    stats: &QueryStats,
    phrases: &[PhraseRows],
    builder: &mut RequestBuilder,
) -> Result<()> {
    builder.clear();
    for (term, token) in query.tokens.iter().enumerate() {
        let group = query.group_of(token);
        builder.term_slot(term as u32);
        for found in typo_tokens_for(entry, token, group, query)? {
            builder.term_list(found.list, stats.frequency(&found.token), 0.0, &found.token)?;
        }
        if let Some(group) = group {
            plan_group(entry, stats, builder, group, term as u32)?;
        }
    }
    for phrase in phrases {
        let frequencies: Vec<f64> = phrase
            .tokens
            .iter()
            .map(|token| stats.frequency(token))
            .collect();
        builder.phrase_slot(&frequencies, &phrase.rows, phrase.key.clone());
    }
    Ok(())
}
