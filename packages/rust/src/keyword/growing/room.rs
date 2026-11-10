use std::collections::{HashMap, HashSet};

use super::GrowingSegment;
use crate::error::Result;
use crate::keyword::lookups::{ABSENT_TERM, lookup_exact_batch};
use crate::keyword::slices::slice_capacities;
use crate::keyword::strings::{SpellingTable, SurfaceTable};
use crate::keyword::tokens::SegmentFieldTokens;
use crate::keyword::workspace::{core_refused, with_workspace};

const NO_SLICE: u8 = u8::MAX;
const RUN_POINTS: usize = 3;

fn slice_class_for(entries: usize) -> usize {
    slice_capacities().partition_point(|&capacity| (capacity as usize) < entries)
}

fn slice_capacity(class: u8) -> usize {
    if class == NO_SLICE {
        return 0;
    }
    slice_capacities()
        .get(class as usize)
        .map_or(0, |&capacity| capacity as usize)
}

struct DocumentNeeds<'a> {
    terms: HashMap<&'a [u16], usize>,
    surfaces: HashSet<&'a [u16]>,
    spellings: HashSet<&'a [u16]>,
    positions: usize,
}

fn document_needs<'a>(
    segment: &GrowingSegment,
    fields: &[SegmentFieldTokens<'a>],
) -> DocumentNeeds<'a> {
    let mut needs = DocumentNeeds {
        terms: HashMap::new(),
        surfaces: HashSet::new(),
        spellings: HashSet::new(),
        positions: 0,
    };
    for field in fields {
        let partial = segment
            .partial_fields
            .get(field.field as usize)
            .is_some_and(|&mark| mark != 0);
        let mut seen: HashSet<&[u16]> = HashSet::new();
        for record in &field.tokens.records {
            let term = field.tokens.term(record);
            seen.insert(term);
            let spelling = match field.tokens.surface(record) {
                Some(surface) if surface != term => {
                    needs.surfaces.insert(surface);
                    surface
                }
                _ => term,
            };
            if partial {
                needs.spellings.insert(spelling);
            }
        }
        needs.positions += field.tokens.len() + seen.len();
        for term in seen {
            *needs.terms.entry(term).or_insert(0) += 1;
        }
    }
    needs
}

fn existing_ordinals(segment: &mut GrowingSegment, terms: &[&[u16]]) -> Result<Vec<u32>> {
    let mut units: Vec<u16> = Vec::new();
    let mut offsets: Vec<u32> = vec![0];
    for term in terms {
        units.extend_from_slice(term);
        offsets.push(units.len() as u32);
    }
    let mut ordinals = vec![ABSENT_TERM; terms.len()];
    let dictionary = segment.dictionary();
    let found = with_workspace(|workspace| {
        Ok(lookup_exact_batch(
            workspace,
            &dictionary,
            &units,
            &offsets,
            &mut ordinals,
        ))
    })?;
    match found {
        Ok(count) => {
            ordinals.truncate(count);
            Ok(ordinals)
        }
        Err(status) => Err(core_refused("an exact term lookup", status)),
    }
}

fn code_points(units: &[u16]) -> usize {
    char::decode_utf16(units.iter().copied()).count()
}

pub(super) fn reserve_for(
    segment: &mut GrowingSegment,
    fields: &[SegmentFieldTokens<'_>],
) -> Result<()> {
    let needs = document_needs(segment, fields);
    let terms: Vec<&[u16]> = needs.terms.keys().copied().collect();
    let ordinals = existing_ordinals(segment, &terms)?;
    let mut new_terms = 0;
    let mut new_units = 0;
    let mut entries = 0;
    for (term, &ordinal) in terms.iter().zip(&ordinals) {
        let added = needs.terms.get(term).copied().unwrap_or(0);
        let held = ordinal as usize;
        if ordinal == ABSENT_TERM || held >= segment.terms.count() {
            new_terms += 1;
            new_units += term.len();
            entries += slice_capacity(slice_class_for(added) as u8);
            continue;
        }
        let needed = segment.columns.lengths.get(held).copied().unwrap_or(0) as usize + added;
        let class = segment
            .columns
            .slice_class
            .get(held)
            .copied()
            .unwrap_or(NO_SLICE);
        if needed > slice_capacity(class) {
            entries += slice_capacity(slice_class_for(needed) as u8);
        }
    }
    let count = segment.terms.count() + new_terms;
    let units = segment.terms.units_used() + new_units;
    segment.terms.reserve(count, units)?;
    segment.columns.match_capacity(segment.terms.capacity());
    let end = segment.postings.end();
    segment.postings.reserve(end + entries)?;
    if let Some(positions) = &mut segment.positions {
        let end = positions.end();
        positions.reserve(end + needs.positions)?;
    }
    if !needs.surfaces.is_empty() {
        let units = needs.surfaces.iter().map(|surface| surface.len()).sum();
        segment
            .surfaces
            .get_or_insert_with(SurfaceTable::new)
            .reserve_more(needs.surfaces.len(), units)?;
    }
    let long: Vec<&[u16]> = needs
        .spellings
        .iter()
        .copied()
        .filter(|spelling| code_points(spelling) > RUN_POINTS)
        .collect();
    if !long.is_empty() {
        let units = long.iter().map(|spelling| spelling.len()).sum();
        let runs = long
            .iter()
            .map(|spelling| code_points(spelling) - (RUN_POINTS - 1))
            .sum();
        segment
            .spellings
            .get_or_insert_with(SpellingTable::new)
            .reserve_more(long.len(), units, runs)?;
    }
    Ok(())
}

pub(super) fn grow_every_region(segment: &mut GrowingSegment) -> Result<()> {
    segment.terms.grow()?;
    segment.columns.match_capacity(segment.terms.capacity());
    segment.postings.grow()?;
    if let Some(positions) = &mut segment.positions {
        positions.grow()?;
    }
    segment
        .surfaces
        .get_or_insert_with(SurfaceTable::new)
        .grow()?;
    if let Some(spellings) = &mut segment.spellings {
        spellings.grow()?;
    }
    Ok(())
}
