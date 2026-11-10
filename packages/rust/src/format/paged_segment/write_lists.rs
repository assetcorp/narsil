use super::SMALLEST_BLOCK_POSTINGS;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::keyword_segment::KeywordSegment;
use crate::util::bytes::{offset_entry, offset_range};

const TARGET_BLOCK_ENTRIES: usize = 128;
const ABSENT_FIELD_LENGTH_BOUND: f64 = 0.0;

/// The token sections of a paged segment, built from a keyword segment's postings.
#[derive(Default)]
pub(super) struct WrittenLists {
    pub(super) document_frequencies: Vec<u8>,
    pub(super) posting_offsets: Vec<u8>,
    pub(super) block_lists: Vec<u8>,
    pub(super) block_list_offsets: Vec<u8>,
    pub(super) block_summaries: Vec<u8>,
    pub(super) postings: Vec<u8>,
    pub(super) token_totals: Vec<u8>,
    pub(super) position_offsets: Vec<u8>,
    pub(super) positions: Vec<u8>,
    pub(super) removal_offsets: Vec<u8>,
    pub(super) removals: Vec<u8>,
}

/// One posting of a token as a paged segment lays it out, with the place of its positions in the writer's list.
pub(crate) struct Row {
    pub(crate) document: u32,
    pub(crate) frequency: u16,
    pub(crate) field: u16,
    pub(crate) posting: usize,
}

fn too_large(what: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!("A paged segment cannot number its {what}"),
    )
}

fn as_u32(value: usize, what: &str) -> Result<u32> {
    u32::try_from(value).map_err(|_| too_large(what))
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn field_length_bound(columns: &[Option<&[u32]>], field: u16, document: u32) -> f64 {
    let stored = columns
        .get(field as usize)
        .copied()
        .flatten()
        .and_then(|column| column.get(document as usize))
        .copied()
        .unwrap_or(0);
    if stored > 0 {
        f64::from(stored)
    } else {
        ABSENT_FIELD_LENGTH_BOUND
    }
}

/// Appends the block summaries of one token's `rows`, ascending by document and then field, to `out`, bounding
/// each block's field lengths with `columns`, the field length column of each field index, and returns how many
/// blocks it wrote.
pub(crate) fn block_summaries(
    rows: &[Row],
    columns: &[Option<&[u32]>],
    out: &mut Vec<u8>,
) -> Result<usize> {
    let mut blocks = 0usize;
    let mut block_start = 0usize;
    let mut max_frequency = 0u16;
    let mut min_length = f64::INFINITY;
    let mut max_run = 0usize;
    let mut documents = 0usize;
    let mut entry = 0usize;
    while entry < rows.len() {
        let document = rows[entry].document;
        let mut run = 0usize;
        while let Some(row) = rows.get(entry + run).filter(|row| row.document == document) {
            max_frequency = max_frequency.max(row.frequency);
            min_length = min_length.min(field_length_bound(columns, row.field, document));
            run += 1;
        }
        max_run = max_run.max(run);
        documents += 1;
        entry += run;
        if entry - block_start >= TARGET_BLOCK_ENTRIES || entry == rows.len() {
            push_u32(out, as_u32(entry, "postings")?);
            out.extend_from_slice(&max_frequency.to_le_bytes());
            let bound = if min_length.is_infinite() {
                ABSENT_FIELD_LENGTH_BOUND
            } else {
                min_length
            };
            out.extend_from_slice(&bound.to_le_bytes());
            push_u32(out, as_u32(max_run, "postings")?);
            push_u32(out, as_u32(documents, "documents")?);
            blocks += 1;
            block_start = entry;
            max_frequency = 0;
            min_length = f64::INFINITY;
            max_run = 0;
            documents = 0;
        }
    }
    Ok(blocks)
}

fn rows_of(segment: &KeywordSegment, token: usize) -> Vec<Row> {
    let mut rows: Vec<Row> = offset_range(&segment.posting_offsets, token)
        .filter_map(|posting| {
            Some(Row {
                document: *segment.posting_documents.get(posting)?,
                frequency: *segment.posting_frequencies.get(posting)?,
                field: *segment.posting_fields.get(posting)?,
                posting,
            })
        })
        .collect();
    rows.sort_by_key(|row| (row.document, row.field));
    rows
}

fn positions_of(segment: &KeywordSegment, posting: usize) -> &[u32] {
    let Some(positions) = &segment.positions else {
        return &[];
    };
    offset_entry(&positions.values, &positions.offsets, posting)
}

/// Writes every token's postings in ascending order of document and then field, with its block summaries, its
/// positions, and what each document contributes to it, as a paged segment lays them out.
pub(super) fn write_lists(segment: &KeywordSegment) -> Result<WrittenLists> {
    let mut out = WrittenLists::default();
    let columns = segment.length_columns();
    let tracks_positions = segment.positions.is_some();
    let mut removals: Vec<Vec<(u32, u32)>> = vec![Vec::new(); segment.document_count as usize];
    let mut postings_written = 0usize;
    let mut positions_written = 0usize;
    push_u32(&mut out.posting_offsets, 0);
    push_u32(&mut out.block_list_offsets, 0);
    let mut summaries_written = 0usize;
    for token in 0..segment.token_count() {
        let rows = rows_of(segment, token);
        let token_number = as_u32(token, "tokens")?;
        let mut distinct = 0u32;
        let mut total = 0f64;
        for (at, row) in rows.iter().enumerate() {
            push_u32(&mut out.postings, row.document);
            total += f64::from(row.frequency);
            if at == 0 || rows[at - 1].document != row.document {
                distinct += 1;
                if let Some(entries) = removals.get_mut(row.document as usize) {
                    entries.push((token_number, 0));
                }
            }
            if let Some(last) = removals
                .get_mut(row.document as usize)
                .and_then(|entries| entries.last_mut())
            {
                last.1 = last.1.saturating_add(u32::from(row.frequency));
            }
        }
        for row in &rows {
            out.postings.extend_from_slice(&row.frequency.to_le_bytes());
        }
        for row in &rows {
            out.postings.extend_from_slice(&row.field.to_le_bytes());
        }
        out.token_totals.extend_from_slice(&total.to_le_bytes());
        push_u32(&mut out.document_frequencies, distinct);
        if tracks_positions {
            for row in &rows {
                push_u32(
                    &mut out.position_offsets,
                    as_u32(positions_written, "positions")?,
                );
                for &position in positions_of(segment, row.posting) {
                    push_u32(&mut out.positions, position);
                }
                positions_written += positions_of(segment, row.posting).len();
            }
        }
        if rows.len() > SMALLEST_BLOCK_POSTINGS {
            push_u32(&mut out.block_lists, token_number);
            summaries_written += block_summaries(&rows, &columns, &mut out.block_summaries)?;
            push_u32(
                &mut out.block_list_offsets,
                as_u32(summaries_written, "blocks")?,
            );
        }
        postings_written += rows.len();
        push_u32(
            &mut out.posting_offsets,
            as_u32(postings_written, "postings")?,
        );
    }
    if tracks_positions {
        push_u32(
            &mut out.position_offsets,
            as_u32(positions_written, "positions")?,
        );
    }
    let mut values_written = 0usize;
    push_u32(&mut out.removal_offsets, 0);
    for entries in &removals {
        for &(token, occurrences) in entries {
            push_u32(&mut out.removals, token);
            push_u32(&mut out.removals, occurrences);
        }
        values_written += entries.len() * 2;
        push_u32(
            &mut out.removal_offsets,
            as_u32(values_written, "removals")?,
        );
    }
    Ok(out)
}
