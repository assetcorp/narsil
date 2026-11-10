use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::frozen::FrozenSegment;
use crate::index::partition::PartitionSnapshot;
use crate::index::segment::{SegmentData, SegmentEntry, bit_is_set};
use crate::index::tail::TailSegment;

const BITS_PER_WORD: u32 = 32;

/// Returns the bitset of the live ordinals of one segment that a listing's filter accepts.
pub(crate) type SegmentMatcher<'a> = dyn Fn(&SegmentEntry) -> Result<Vec<u32>> + 'a;

/// The IDs that one partition offers a listing page, in ascending code point order, and the number of documents of
/// the partition that the listing covers.
pub(crate) struct PartitionPage {
    pub(crate) ids: Vec<String>,
    pub(crate) total: u64,
}

struct SeekRequest<'a> {
    anchor: Option<&'a str>,
    matches: Option<&'a [u32]>,
    wanted: usize,
}

impl SeekRequest<'_> {
    fn accepts(&self, entry: &SegmentEntry, ordinal: u32) -> bool {
        !entry.is_removed(ordinal) && self.matches.is_none_or(|bits| bit_is_set(bits, ordinal))
    }
}

fn missing_order(position: u32) -> NarsilError {
    NarsilError::new(
        ErrorCode::PARTITION_CORRUPTED,
        format!("A frozen segment holds no document at position {position} of its ID order"),
    )
}

fn sorted_ordinal(segment: &FrozenSegment, position: u32) -> Result<u32> {
    match &segment.paged {
        Some(paged) => paged.sorted_ordinal(position),
        None => segment
            .payload
            .id_order
            .get(position as usize)
            .copied()
            .ok_or_else(|| missing_order(position)),
    }
}

fn first_position_after(segment: &FrozenSegment, anchor: &str) -> Result<u32> {
    let mut low = 0u32;
    let mut high = segment.capacity();
    while low < high {
        let middle = low + (high - low) / 2;
        let ordinal = sorted_ordinal(segment, middle)?;
        if segment.id(ordinal)?.as_ref() <= anchor {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    Ok(low)
}

fn frozen_candidates(
    entry: &SegmentEntry,
    segment: &FrozenSegment,
    request: &SeekRequest<'_>,
    out: &mut Vec<String>,
) -> Result<()> {
    let capacity = segment.capacity();
    let mut position = match request.anchor {
        Some(anchor) => first_position_after(segment, anchor)?,
        None => 0,
    };
    let mut taken = 0;
    while position < capacity && taken < request.wanted {
        let ordinal = sorted_ordinal(segment, position)?;
        position += 1;
        if !request.accepts(entry, ordinal) {
            continue;
        }
        out.push(segment.id(ordinal)?.into_owned());
        taken += 1;
    }
    Ok(())
}

fn tail_candidates(
    entry: &SegmentEntry,
    tail: &TailSegment,
    request: &SeekRequest<'_>,
    out: &mut Vec<String>,
) {
    let mut found: Vec<&str> = tail
        .ids
        .iter()
        .enumerate()
        .filter(|(ordinal, id)| {
            request.accepts(entry, *ordinal as u32)
                && request.anchor.is_none_or(|anchor| id.as_str() > anchor)
        })
        .map(|(_, id)| id.as_str())
        .collect();
    if found.len() > request.wanted {
        found.select_nth_unstable(request.wanted);
        found.truncate(request.wanted);
    }
    out.extend(found.into_iter().map(str::to_string));
}

fn matched_live_count(entry: &SegmentEntry, bits: &[u32]) -> u64 {
    let mut count = 0;
    for (word_at, word) in bits.iter().enumerate() {
        let mut word = *word;
        while word != 0 {
            let ordinal = (word_at as u32) * BITS_PER_WORD + word.trailing_zeros();
            if ordinal < entry.capacity() && !entry.is_removed(ordinal) {
                count += 1;
            }
            word &= word - 1;
        }
    }
    count
}

/// Returns up to `wanted` IDs of the partition's live documents that sort after `anchor` and that `matcher`
/// accepts, seeking each frozen segment through its ID order, with the number of documents that the listing covers.
pub(crate) fn partition_candidates(
    snapshot: &PartitionSnapshot,
    anchor: Option<&str>,
    matcher: Option<&SegmentMatcher<'_>>,
    wanted: usize,
) -> Result<PartitionPage> {
    let mut ids = Vec::new();
    let mut matched = 0u64;
    for entry in &snapshot.segments {
        if entry.live_count() == 0 {
            continue;
        }
        let bits = match matcher {
            Some(matcher) => {
                let bits = matcher(entry)?;
                matched += matched_live_count(entry, &bits);
                Some(bits)
            }
            None => None,
        };
        let request = SeekRequest {
            anchor,
            matches: bits.as_deref(),
            wanted,
        };
        match &entry.data {
            SegmentData::Frozen(segment) => frozen_candidates(entry, segment, &request, &mut ids)?,
            SegmentData::Tail(tail) => tail_candidates(entry, tail, &request, &mut ids),
        }
    }
    ids.sort_unstable();
    ids.dedup();
    ids.truncate(wanted);
    let total = match matcher {
        Some(_) => matched,
        None => snapshot.document_count(),
    };
    Ok(PartitionPage { ids, total })
}
