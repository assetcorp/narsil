use std::collections::HashMap;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::keyword_segment::MAX_SEGMENT_FIELD_NAMES;
use crate::index::segment::{SegmentData, SegmentEntry};

const DROPPED: u32 = u32::MAX;

pub(crate) struct MergeInput<'a> {
    pub(crate) entry: &'a SegmentEntry,
    pub(crate) remap: Vec<u32>,
    pub(crate) field_remap: Vec<u16>,
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

pub(crate) fn as_u32(value: usize, what: &str) -> Result<u32> {
    u32::try_from(value).map_err(|_| too_large(what))
}

impl MergeInput<'_> {
    pub(crate) fn target(&self, ordinal: u32) -> Option<u32> {
        self.remap
            .get(ordinal as usize)
            .copied()
            .filter(|&target| target != DROPPED)
    }
}

pub(crate) fn field_names_of(entry: &SegmentEntry) -> &[String] {
    match &entry.data {
        SegmentData::Frozen(segment) => segment.field_names(),
        SegmentData::Tail(tail) => &tail.field_names,
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
        let names = field_names_of(entry);
        let mut field_remap = Vec::with_capacity(names.len());
        for name in names {
            let at = index_of(&mut field_names, &mut slots, name);
            if field_names.len() > MAX_SEGMENT_FIELD_NAMES {
                return Err(too_large("field names"));
            }
            field_remap.push(u16::try_from(at).map_err(|_| too_large("field names"))?);
        }
        inputs.push(MergeInput {
            entry,
            remap,
            field_remap,
        });
    }
    Ok((inputs, kept, field_names))
}
