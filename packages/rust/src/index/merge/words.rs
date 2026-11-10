use std::collections::{BTreeMap, HashMap};

use super::inputs::{MergeInput, as_u32, too_large};
use super::postings::MergedPostings;
use crate::error::Result;
use crate::format::keyword_columns::{PartialWords, SurfaceForms};
use crate::index::constants::PARTIAL_WORD_RUN_CODE_POINTS;
use crate::index::segment::SegmentData;

const MAX_ARRAY_INDEX: u64 = 4_294_967_294;

type Run = [u32; PARTIAL_WORD_RUN_CODE_POINTS];

/// Returns the number that `key` reads as where a JavaScript object would list it among its array indices, which
/// come before every other key in ascending numeric order.
fn array_index(key: &str) -> Option<u64> {
    let bytes = key.as_bytes();
    let canonical = match bytes {
        [b'0'] => true,
        [first, rest @ ..] => (b'1'..=b'9').contains(first) && rest.iter().all(u8::is_ascii_digit),
        [] => false,
    };
    if !canonical {
        return None;
    }
    key.parse::<u64>()
        .ok()
        .filter(|&index| index <= MAX_ARRAY_INDEX)
}

/// Returns the surfaces of one input in the order that the reference writer lists them: a frozen segment's as
/// stored, and a tail's in the order that its live documents first wrote them, as a segment built from those
/// documents alone would hold them.
fn surfaces_in_order<'a>(input: &MergeInput<'a>) -> Vec<&'a str> {
    let stored = input.entry.stored_surfaces();
    let SegmentData::Tail(tail) = &input.entry.data else {
        return stored.first_met.iter().map(String::as_str).collect();
    };
    let mut met = vec![false; stored.first_met.len()];
    let mut order = Vec::with_capacity(stored.first_met.len());
    for ordinal in input.entry.live_ordinals() {
        let Some(slots) = tail.document_surfaces.get(ordinal as usize) else {
            continue;
        };
        for &slot in slots {
            let (Some(seen), Some(surface)) = (
                met.get_mut(slot as usize),
                stored.first_met.get(slot as usize),
            ) else {
                continue;
            };
            if !*seen {
                *seen = true;
                order.push(surface.as_str());
            }
        }
    }
    order
}

/// Joins the surface forms that the kept documents of the inputs wrote, counting only live occurrences, keeping
/// the first token met for each surface, and listing them in the order that the reference writer's object would.
pub(crate) fn merge_surfaces(inputs: &[MergeInput<'_>]) -> Result<Option<SurfaceForms>> {
    let mut order: Vec<&str> = Vec::new();
    let mut held: HashMap<&str, (&str, u64)> = HashMap::new();
    for input in inputs {
        let stored = input.entry.stored_surfaces();
        let removed = &input.entry.removed_words;
        for surface in surfaces_in_order(input) {
            let Some((token, count)) = stored.entries.get(surface) else {
                continue;
            };
            let live = removed.surface_count(surface, *count);
            if live == 0 || surface.is_empty() || token.is_empty() || surface == token.as_str() {
                continue;
            }
            match held.get_mut(surface) {
                Some((_, total)) => *total = total.saturating_add(live),
                None => {
                    order.push(surface);
                    held.insert(surface, (token, live));
                }
            }
        }
    }
    if order.is_empty() {
        return Ok(None);
    }
    let mut indexed: Vec<(u64, &str)> = Vec::new();
    let mut named: Vec<&str> = Vec::with_capacity(order.len());
    for surface in order {
        match array_index(surface) {
            Some(index) => indexed.push((index, surface)),
            None => named.push(surface),
        }
    }
    indexed.sort_unstable();
    let mut forms = SurfaceForms {
        text: Vec::new(),
        offsets: vec![0],
        counts: Vec::with_capacity(held.len()),
    };
    for surface in indexed.into_iter().map(|(_, surface)| surface).chain(named) {
        let Some(&(token, count)) = held.get(surface) else {
            continue;
        };
        forms.text.extend_from_slice(surface.as_bytes());
        forms
            .offsets
            .push(as_u32(forms.text.len(), "surface form bytes")?);
        forms.text.extend_from_slice(token.as_bytes());
        forms
            .offsets
            .push(as_u32(forms.text.len(), "surface form bytes")?);
        forms
            .counts
            .push(u32::try_from(count).map_err(|_| too_large("surface form occurrences"))?);
    }
    Ok(Some(forms))
}

/// Joins the partial-word spellings of the inputs into the table that the reference writer builds: live counts
/// summed for each spelling and token, entries in code point order of their spelling and then by token, and every
/// run of three code points with the entries that hold it. Returns `None` where the schema has no partial field.
pub(crate) fn merge_partial_words(
    inputs: &[MergeInput<'_>],
    postings: &MergedPostings,
    partial_fields: Vec<String>,
) -> Result<Option<PartialWords>> {
    if partial_fields.is_empty() {
        return Ok(None);
    }
    let mut entries: BTreeMap<(&str, u32), u64> = BTreeMap::new();
    for input in inputs {
        let removed = &input.entry.removed_words;
        for entry in input.entry.stored_spellings().entries() {
            let live = removed.spelling_count(&entry.spelling, &entry.token, entry.count);
            if live == 0 || entry.spelling.chars().count() <= PARTIAL_WORD_RUN_CODE_POINTS {
                continue;
            }
            let Some(token) = postings.token_index(&entry.token) else {
                continue;
            };
            let total = entries.entry((entry.spelling.as_str(), token)).or_insert(0);
            *total = total.saturating_add(live);
        }
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
