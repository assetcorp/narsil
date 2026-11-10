use std::borrow::Cow;
use std::cmp::Ordering;
use std::sync::Arc;

use super::documents::{FieldReader, Location, matched_ordinals};
use super::facets::MatchedSegment;
use super::params::SortMode;
use super::sort_keys::SortPlan;
use crate::error::Result;
use crate::index::segment::SegmentEntry;
use crate::ordering::{KeyColumn, SortKey, SortValue, compare_keys};

pub(crate) struct Candidate<'s> {
    pub(crate) id: Cow<'s, str>,
    pub(crate) location: Location,
    pub(crate) key_at: usize,
}

pub(crate) struct Gathered<'s> {
    pub(crate) keys: Vec<SortValue<'s>>,
    pub(crate) candidates: Vec<Candidate<'s>>,
}

pub(crate) struct SortAnchor<'a> {
    pub(crate) id: &'a str,
    pub(crate) keys: Vec<SortKey>,
}

impl SortAnchor<'_> {
    pub(crate) fn of<'a>(id: &'a str, values: &[SortValue<'_>], width: usize) -> SortAnchor<'a> {
        SortAnchor {
            id,
            keys: (0..width)
                .map(|at| SortKey::of(values.get(at).copied().unwrap_or(SortValue::Missing)))
                .collect(),
        }
    }
}

fn key_column(entry: &SegmentEntry, path: &str, mode: SortMode) -> Result<Arc<KeyColumn>> {
    entry.derived().sort_keys.column(
        |(held_path, held_mode)| held_path == path && *held_mode == mode,
        || (path.to_string(), mode),
        entry.capacity() as usize,
        |column, range| {
            let reader = FieldReader::of(entry, path)?;
            column
                .extend(range.map(|ordinal| SortKey::of_stored(reader.get(ordinal as u32), mode)));
            Ok(())
        },
    )
}

pub(crate) fn key_columns(
    entry: &SegmentEntry,
    plan: &SortPlan<'_>,
) -> Result<Vec<Arc<KeyColumn>>> {
    plan.fields
        .iter()
        .zip(&plan.modes)
        .map(|(path, mode)| key_column(entry, path, *mode))
        .collect()
}

fn compare_rows(
    columns: &[Arc<KeyColumn>],
    plan: &SortPlan<'_>,
    left: u32,
    right: u32,
) -> Ordering {
    columns
        .iter()
        .zip(&plan.directions)
        .map(|(column, direction)| column.compare_at(left, right, *direction))
        .find(|comparison| *comparison != Ordering::Equal)
        .unwrap_or(Ordering::Equal)
}

fn after_anchor(
    columns: &[Arc<KeyColumn>],
    plan: &SortPlan<'_>,
    entry: &SegmentEntry,
    ordinal: u32,
    anchor: &SortAnchor<'_>,
) -> Result<bool> {
    let by_key = columns
        .iter()
        .zip(&anchor.keys)
        .zip(&plan.directions)
        .map(|((column, key), direction)| compare_keys(column.key(ordinal), key, *direction))
        .find(|comparison| *comparison != Ordering::Equal)
        .unwrap_or(Ordering::Equal);
    Ok(match by_key {
        Ordering::Equal => *entry.id_of(ordinal)? > *anchor.id,
        comparison => comparison == Ordering::Greater,
    })
}

fn first_tied_by_id(entry: &SegmentEntry, tied: Vec<u32>, open: usize) -> Result<Vec<u32>> {
    let mut named = tied
        .into_iter()
        .map(|ordinal| Ok((entry.id_of(ordinal)?, ordinal)))
        .collect::<Result<Vec<(Cow<'_, str>, u32)>>>()?;
    named.select_nth_unstable_by(open - 1, |left, right| left.0.cmp(&right.0));
    named.truncate(open);
    Ok(named.into_iter().map(|(_, ordinal)| ordinal).collect())
}

fn first_rows(
    mut ordinals: Vec<u32>,
    wanted: usize,
    columns: &[Arc<KeyColumn>],
    plan: &SortPlan<'_>,
    entry: &SegmentEntry,
) -> Result<Vec<u32>> {
    if wanted == 0 {
        return Ok(Vec::new());
    }
    if ordinals.len() <= wanted {
        return Ok(ordinals);
    }
    let by_key = |left: &u32, right: &u32| compare_rows(columns, plan, *left, *right);
    ordinals.select_nth_unstable_by(wanted - 1, by_key);
    let boundary = ordinals[wanted - 1];
    let (mut ahead, tied): (Vec<u32>, Vec<u32>) = ordinals
        .into_iter()
        .filter(|ordinal| by_key(ordinal, &boundary) != Ordering::Greater)
        .partition(|ordinal| by_key(ordinal, &boundary) == Ordering::Less);
    let open = wanted.saturating_sub(ahead.len());
    let mut kept = match tied.len() > open && open > 0 {
        true => first_tied_by_id(entry, tied, open)?,
        false => tied.into_iter().take(open).collect(),
    };
    ahead.append(&mut kept);
    Ok(ahead)
}

pub(crate) fn gather_segment<'s>(
    gathered: &mut Gathered<'s>,
    segment: &MatchedSegment<'s>,
    columns: &'s [Arc<KeyColumn>],
    plan: &SortPlan<'_>,
    anchor: Option<&SortAnchor<'_>>,
    wanted: usize,
) -> Result<()> {
    let entry = segment.entry;
    let mut ordinals = Vec::new();
    for ordinal in matched_ordinals(&segment.words) {
        let keeps = match anchor {
            None => true,
            Some(anchor) => after_anchor(columns, plan, entry, ordinal, anchor)?,
        };
        if keeps {
            ordinals.push(ordinal);
        }
    }
    for ordinal in first_rows(ordinals, wanted, columns, plan, entry)? {
        let key_at = gathered.keys.len();
        gathered
            .keys
            .extend(columns.iter().map(|column| column.key(ordinal).value()));
        gathered.candidates.push(Candidate {
            id: entry.id_of(ordinal)?,
            location: Location {
                partition: segment.partition,
                segment: segment.segment,
                ordinal,
            },
            key_at,
        });
    }
    Ok(())
}
