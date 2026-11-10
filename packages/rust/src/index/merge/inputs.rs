use std::collections::HashMap;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::keyword_columns::FieldLengthColumn;
use crate::format::keyword_segment::MAX_SEGMENT_FIELD_NAMES;
use crate::index::segment::{SegmentData, SegmentEntry};

const DROPPED: u32 = u32::MAX;

/// One segment that a merge reads, with the ordinal in the merged segment of each document that it keeps and the
/// merged index of each of its field names.
pub(crate) struct MergeInput<'a> {
    pub(crate) entry: &'a SegmentEntry,
    remap: Vec<u32>,
    field_order: Vec<u16>,
    field_remap: Vec<Option<u16>>,
}

pub(crate) fn too_large(what: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!("The merged segment would hold more {what} than its layout can number"),
    )
}

pub(crate) fn damaged(what: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PARTITION_CORRUPTED,
        format!("A segment of the partition {what}"),
    )
}

/// Converts a count or an offset to the 32-bit number that a keyword segment stores, or raises
/// `PERSISTENCE_SAVE_FAILED` where it does not fit.
pub(crate) fn as_u32(value: usize, what: &str) -> Result<u32> {
    u32::try_from(value).map_err(|_| too_large(what))
}

impl MergeInput<'_> {
    /// Returns the merged ordinal of the document at `ordinal`, or `None` where the merge drops it.
    pub(crate) fn target(&self, ordinal: u32) -> Option<u32> {
        self.remap
            .get(ordinal as usize)
            .copied()
            .filter(|&target| target != DROPPED)
    }

    /// Returns the merged index of the field at `field` of this segment's field names.
    pub(crate) fn field(&self, field: u16) -> Result<u16> {
        self.field_remap
            .get(field as usize)
            .copied()
            .flatten()
            .ok_or_else(|| damaged("names a posting field outside its field names"))
    }

    /// Returns each field length column of this input with its field name, in the order that the merge joins
    /// them.
    pub(crate) fn field_length_columns(&self) -> Vec<(&str, &[u32])> {
        match &self.entry.data {
            SegmentData::Frozen(segment) => segment
                .payload
                .field_lengths
                .iter()
                .map(|column| (column.field.as_str(), column.lengths.as_slice()))
                .collect(),
            SegmentData::Tail(tail) => self
                .field_order
                .iter()
                .filter_map(|&slot| {
                    let name = tail.field_names.get(slot as usize)?;
                    let lengths = tail.field_lengths.get(slot as usize)?;
                    Some((name.as_str(), lengths.as_slice()))
                })
                .collect(),
        }
    }
}

fn field_names_of(entry: &SegmentEntry) -> &[String] {
    match &entry.data {
        SegmentData::Frozen(segment) => segment.field_names(),
        SegmentData::Tail(tail) => &tail.field_names,
    }
}

/// Returns the field slots of `entry` in the order that the merge joins their names: a frozen segment's every
/// name as stored, and a tail's names in the order that its live documents first wrote them, as a segment built
/// from those documents alone would hold them.
fn field_order(entry: &SegmentEntry) -> Result<Vec<u16>> {
    match &entry.data {
        SegmentData::Frozen(segment) => (0..segment.field_names().len())
            .map(|slot| u16::try_from(slot).map_err(|_| damaged("holds too many field names")))
            .collect(),
        SegmentData::Tail(tail) => {
            let mut met = vec![false; tail.field_names.len()];
            let mut order = Vec::with_capacity(tail.field_names.len());
            for ordinal in entry.live_ordinals() {
                let Some(words) = tail.words.get(ordinal as usize) else {
                    continue;
                };
                for &(slot, _) in &words.field_lengths {
                    if let Some(seen) = met.get_mut(slot as usize) {
                        if !*seen {
                            *seen = true;
                            order.push(slot);
                        }
                    }
                }
            }
            Ok(order)
        }
    }
}

fn index_of(names: &mut Vec<String>, slots: &mut HashMap<String, usize>, name: &str) -> usize {
    if let Some(&at) = slots.get(name) {
        return at;
    }
    let at = names.len();
    names.push(name.to_string());
    slots.insert(name.to_string(), at);
    at
}

/// Numbers the kept documents of `entries` in order, oldest segment first, and joins their field names in the order
/// that the segments first name them, as the reference merge does.
pub(crate) fn prepare(entries: &[SegmentEntry]) -> Result<(Vec<MergeInput<'_>>, u32, Vec<String>)> {
    let mut kept: u32 = 0;
    let mut field_names = Vec::new();
    let mut slots = HashMap::new();
    let mut inputs = Vec::with_capacity(entries.len());
    for entry in entries {
        let capacity = entry.capacity();
        let mut remap = vec![DROPPED; capacity as usize];
        for ordinal in entry.live_ordinals() {
            let Some(slot) = remap.get_mut(ordinal as usize) else {
                continue;
            };
            if kept == DROPPED {
                return Err(too_large("documents"));
            }
            *slot = kept;
            kept += 1;
        }
        let order = field_order(entry)?;
        let names = field_names_of(entry);
        let mut field_remap = vec![None; names.len()];
        for &slot in &order {
            let (Some(name), Some(merged)) =
                (names.get(slot as usize), field_remap.get_mut(slot as usize))
            else {
                continue;
            };
            let at = index_of(&mut field_names, &mut slots, name);
            if field_names.len() > MAX_SEGMENT_FIELD_NAMES {
                return Err(too_large("field names"));
            }
            *merged = Some(u16::try_from(at).map_err(|_| too_large("field names"))?);
        }
        inputs.push(MergeInput {
            entry,
            remap,
            field_order: order,
            field_remap,
        });
    }
    Ok((inputs, kept, field_names))
}

/// Joins the field length columns of the inputs, in the order that the inputs first name each field, with 0 for a
/// document that holds no value in a field.
pub(crate) fn merge_field_lengths(
    inputs: &[MergeInput<'_>],
    document_count: u32,
) -> Vec<FieldLengthColumn> {
    let mut columns: Vec<FieldLengthColumn> = Vec::new();
    let mut slots: HashMap<String, usize> = HashMap::new();
    for input in inputs {
        for (name, lengths) in input.field_length_columns() {
            let at = match slots.get(name) {
                Some(&at) => at,
                None => {
                    slots.insert(name.to_string(), columns.len());
                    columns.push(FieldLengthColumn {
                        field: name.to_string(),
                        lengths: vec![0; document_count as usize],
                    });
                    columns.len() - 1
                }
            };
            let column = &mut columns[at].lengths;
            for (ordinal, &length) in lengths.iter().enumerate() {
                let Ok(ordinal) = u32::try_from(ordinal) else {
                    break;
                };
                if let Some(slot) = input
                    .target(ordinal)
                    .and_then(|target| column.get_mut(target as usize))
                {
                    *slot = length;
                }
            }
        }
    }
    columns
}
