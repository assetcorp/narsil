use std::collections::BTreeMap;

use super::inputs::{as_u32, too_large};
use super::keywords::MergedPostings;
use super::sources::PairTable;
use crate::error::Result;
use crate::format::keyword_columns::PartialWords;
use crate::index::constants::PARTIAL_WORD_RUN_CODE_POINTS;

type Run = [u32; PARTIAL_WORD_RUN_CODE_POINTS];

pub(super) fn partial_table(
    spellings: &PairTable,
    postings: &MergedPostings,
    partial_fields: Vec<String>,
) -> Result<Option<PartialWords>> {
    if partial_fields.is_empty() {
        return Ok(None);
    }
    let mut entries: BTreeMap<(&str, u32), u64> = BTreeMap::new();
    for (at, &count) in spellings.counts.iter().enumerate() {
        let Some((spelling, token)) = spellings.pair(at) else {
            continue;
        };
        let Ok(spelling) = std::str::from_utf8(spelling) else {
            continue;
        };
        if count == 0 || spelling.chars().count() <= PARTIAL_WORD_RUN_CODE_POINTS {
            continue;
        }
        let Some(token) = postings.token_index(token) else {
            continue;
        };
        let total = entries.entry((spelling, token)).or_insert(0);
        *total = total.saturating_add(u64::from(count));
    }
    let mut table = PartialWords {
        fields: partial_fields,
        text: Vec::new(),
        offsets: Vec::with_capacity(entries.len() + 1),
        tokens: Vec::with_capacity(entries.len()),
        counts: Vec::with_capacity(entries.len()),
        runs: Vec::new(),
        run_offsets: Vec::new(),
        run_entries: Vec::new(),
    };
    table.offsets.push(0);
    let mut members: BTreeMap<Run, Vec<u32>> = BTreeMap::new();
    let mut points: Vec<u32> = Vec::new();
    for (at, ((spelling, token), count)) in entries.into_iter().enumerate() {
        let entry = as_u32(at, "partial-word spellings")?;
        table.text.extend_from_slice(spelling.as_bytes());
        table
            .offsets
            .push(as_u32(table.text.len(), "partial-word spelling bytes")?);
        table.tokens.push(token);
        table
            .counts
            .push(u32::try_from(count).map_err(|_| too_large("partial-word occurrences"))?);
        points.clear();
        points.extend(spelling.chars().map(u32::from));
        for window in points.windows(PARTIAL_WORD_RUN_CODE_POINTS) {
            if let [first, second, third] = *window {
                let list = members.entry([first, second, third]).or_default();
                if list.last() != Some(&entry) {
                    list.push(entry);
                }
            }
        }
    }
    table.run_offsets.push(0);
    for (run, list) in members {
        table.runs.extend_from_slice(&run);
        table.run_entries.extend_from_slice(&list);
        table
            .run_offsets
            .push(as_u32(table.run_entries.len(), "partial-word run entries")?);
    }
    Ok(Some(table))
}
