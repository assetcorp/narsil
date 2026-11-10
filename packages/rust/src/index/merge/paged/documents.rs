use std::borrow::Cow;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};

use super::super::documents::append_document;
use super::super::inputs::{MergeInput, as_u32, damaged};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::paged_segment::ID_SAMPLE_INTERVAL;
use crate::format::paged_segment::blocks::DocumentBlocks;
use crate::format::paged_segment::encode_id_sample;
use crate::format::paged_segment::sink::SectionSink;
use crate::index::segment::SegmentData;

/// The scratch files that the document walk of a paged merge writes stored documents and IDs to.
pub(super) struct DocumentSinks {
    pub(super) documents: SectionSink,
    pub(super) ids: SectionSink,
    pub(super) id_offsets: SectionSink,
}

/// Copies the IDs and documents that the inputs keep, in merged ordinal order, removing every vector value that
/// the schema declares, and returns the `documentBlocks` section that lists the compressed blocks.
pub(super) fn write_documents(
    inputs: &[MergeInput<'_>],
    vector_paths: &HashSet<String>,
    sinks: &mut DocumentSinks,
) -> Result<Vec<u8>> {
    let mut blocks = DocumentBlocks::default();
    let mut stored = Vec::new();
    let mut id_bytes = 0usize;
    sinks.id_offsets.write_u32(0)?;
    for input in inputs {
        for ordinal in input.entry.live_ordinals() {
            let Some(target) = input.target(ordinal) else {
                continue;
            };
            let id = input.entry.id_of(ordinal)?;
            sinks.ids.write(id.as_bytes())?;
            id_bytes += id.len();
            sinks.id_offsets.write_u32(as_u32(id_bytes, "ID bytes")?)?;
            stored.clear();
            append_document(input, ordinal, vector_paths, &mut stored)?;
            blocks.add(target, &stored, &mut |bytes| sinks.documents.write(bytes))?;
        }
    }
    blocks.finish(&mut |bytes| sinks.documents.write(bytes))
}

enum IdWalk<'a> {
    Listed(Cow<'a, [u32]>, usize),
    Paged(&'a crate::index::paged::PagedSections, u32, u32),
}

fn walk_of<'a>(input: &MergeInput<'a>) -> IdWalk<'a> {
    match &input.entry.data {
        SegmentData::Frozen(segment) => match &segment.paged {
            Some(paged) => IdWalk::Paged(paged, 0, segment.capacity()),
            None => IdWalk::Listed(Cow::Borrowed(&segment.payload.id_order), 0),
        },
        SegmentData::Tail(tail) => {
            let mut order: Vec<u32> = input.entry.live_ordinals().collect();
            order.sort_unstable_by(|&left, &right| {
                let id = |ordinal: u32| tail.ids.get(ordinal as usize).map_or("", String::as_str);
                id(left).cmp(id(right))
            });
            IdWalk::Listed(Cow::Owned(order), 0)
        }
    }
}

impl IdWalk<'_> {
    fn next_ordinal(&mut self) -> Result<Option<u32>> {
        match self {
            IdWalk::Listed(order, at) => {
                let ordinal = order.get(*at).copied();
                *at += 1;
                Ok(ordinal)
            }
            IdWalk::Paged(paged, position, count) => {
                if *position >= *count {
                    return Ok(None);
                }
                let ordinal = paged.sorted_ordinal(*position)?;
                *position += 1;
                Ok(Some(ordinal))
            }
        }
    }

    fn next_kept(&mut self, input: &MergeInput<'_>) -> Result<Option<(String, u32)>> {
        while let Some(ordinal) = self.next_ordinal()? {
            if let Some(target) = input.target(ordinal) {
                return Ok(Some((input.entry.id_of(ordinal)?.into_owned(), target)));
            }
        }
        Ok(None)
    }
}

/// Writes the ordinals of the merged segment in ascending ID order, joining the ID order of every input, and
/// returns the `idSample` section. Raises `PARTITION_CORRUPTED` where two kept documents share an ID or an input
/// lists its IDs out of order.
pub(super) fn write_id_order(
    inputs: &[MergeInput<'_>],
    document_count: u32,
    id_order: &mut SectionSink,
) -> Result<Vec<u8>> {
    let mut walks: Vec<IdWalk<'_>> = inputs.iter().map(walk_of).collect();
    let mut targets = vec![0u32; inputs.len()];
    let mut heap = BinaryHeap::new();
    for (at, (walk, input)) in walks.iter_mut().zip(inputs).enumerate() {
        if let Some((id, target)) = walk.next_kept(input)? {
            targets[at] = target;
            heap.push(Reverse((id, at)));
        }
    }
    let mut sample = Vec::new();
    let mut previous: Option<String> = None;
    let mut position = 0u64;
    while let Some(Reverse((id, at))) = heap.pop() {
        if let Some(before) = &previous {
            if *before == id {
                return Err(NarsilError::new(
                    ErrorCode::PARTITION_CORRUPTED,
                    format!("The segments of the partition hold document \"{id}\" more than once"),
                ));
            }
            if before.as_bytes() > id.as_bytes() {
                return Err(damaged("lists its IDs out of order"));
            }
        }
        id_order.write_u32(targets.get(at).copied().unwrap_or(0))?;
        if position % ID_SAMPLE_INTERVAL as u64 == 0 {
            sample.push((position, id.clone()));
        }
        position += 1;
        if let (Some(walk), Some(input)) = (walks.get_mut(at), inputs.get(at))
            && let Some((next, target)) = walk.next_kept(input)?
        {
            if let Some(slot) = targets.get_mut(at) {
                *slot = target;
            }
            heap.push(Reverse((next, at)));
        }
        previous = Some(id);
    }
    if position != u64::from(document_count) {
        return Err(damaged(
            "lists a document in its ID order more or less than once",
        ));
    }
    Ok(encode_id_sample(&sample))
}
