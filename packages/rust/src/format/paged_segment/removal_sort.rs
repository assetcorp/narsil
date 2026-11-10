use super::constants::{
    LARGEST_REMOVAL_BUCKET_COUNT, REMOVAL_BUCKET_TARGET_BYTES, REMOVAL_BUCKET_WRITE_BUFFER_BYTES,
};
use super::sink::{ScratchFile, ScratchNames, SectionSink};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::util::bytes::le_u32;

const TRIPLE_BYTES: usize = 12;
const VALUES_PER_ENTRY: u64 = 2;

struct Bucket {
    scratch: ScratchFile,
    held: Vec<u8>,
    triples: u64,
}

/// Gathers the removal entry of every document of a paged segment, one token at a time, in scratch files that each
/// hold a run of document ordinals, so that the writer lays them out in ordinal order without holding them all.
pub(crate) struct RemovalWriter {
    buckets: Vec<Bucket>,
    ordinals_per_bucket: u32,
    document_count: u32,
}

fn save_failed(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::PERSISTENCE_SAVE_FAILED, message)
}

fn held_capacity() -> usize {
    (REMOVAL_BUCKET_WRITE_BUFFER_BYTES / TRIPLE_BYTES).max(1) * TRIPLE_BYTES
}

impl RemovalWriter {
    /// Opens a writer for `document_count` documents whose entries hold at most `upper_bound_entries` pairs, with
    /// enough scratch files that each holds near `REMOVAL_BUCKET_TARGET_BYTES`.
    pub(crate) fn open(
        names: &ScratchNames,
        document_count: u32,
        upper_bound_entries: u64,
    ) -> Result<RemovalWriter> {
        let wanted = upper_bound_entries
            .saturating_mul(TRIPLE_BYTES as u64)
            .div_ceil(REMOVAL_BUCKET_TARGET_BYTES);
        let bucket_count = wanted.clamp(1, LARGEST_REMOVAL_BUCKET_COUNT) as u32;
        let ordinals_per_bucket = document_count.div_ceil(bucket_count).max(1);
        let mut buckets = Vec::with_capacity(bucket_count as usize);
        for at in 0..bucket_count {
            buckets.push(Bucket {
                scratch: names.create(&format!("removals-{at}"))?,
                held: Vec::with_capacity(held_capacity()),
                triples: 0,
            });
        }
        Ok(RemovalWriter {
            buckets,
            ordinals_per_bucket,
            document_count,
        })
    }

    /// Records that the document at `ordinal` holds `token` `occurrences` times. A document's tokens arrive in
    /// ascending order.
    pub(crate) fn add(&mut self, ordinal: u32, token: u32, occurrences: u32) -> Result<()> {
        let at = (ordinal / self.ordinals_per_bucket) as usize;
        let Some(bucket) = self
            .buckets
            .get_mut(at)
            .filter(|_| ordinal < self.document_count)
        else {
            return Err(save_failed(format!(
                "A removal entry names document {ordinal} of {}",
                self.document_count
            )));
        };
        bucket.held.extend_from_slice(&ordinal.to_le_bytes());
        bucket.held.extend_from_slice(&token.to_le_bytes());
        bucket.held.extend_from_slice(&occurrences.to_le_bytes());
        bucket.triples += 1;
        if bucket.held.len() >= held_capacity() {
            bucket.scratch.append(&bucket.held)?;
            bucket.held.clear();
        }
        Ok(())
    }

    /// Writes the `removalOffsets` and `removals` sections in ordinal order, one scratch file at a time.
    pub(crate) fn drain(self, offsets: &mut SectionSink, values: &mut SectionSink) -> Result<()> {
        let mut next_value = 0u64;
        let per = self.ordinals_per_bucket;
        for (at, bucket) in self.buckets.into_iter().enumerate() {
            let first = (at as u32).saturating_mul(per).min(self.document_count);
            let end = first.saturating_add(per).min(self.document_count);
            next_value = drain_bucket(bucket, first, end, next_value, offsets, values)?;
        }
        offsets.write_u32(as_value(next_value)?)
    }
}

fn as_value(value: u64) -> Result<u32> {
    u32::try_from(value)
        .map_err(|_| save_failed("A paged segment cannot number its removals".into()))
}

fn read_triples(
    bucket: &mut Bucket,
    visit: &mut dyn FnMut(u32, u32, u32) -> Result<()>,
) -> Result<()> {
    let stored = bucket.scratch.rewind()?;
    if stored != bucket.triples.saturating_mul(TRIPLE_BYTES as u64) {
        return Err(save_failed(format!(
            "A removal scratch file holds {stored} bytes for {} entries",
            bucket.triples
        )));
    }
    let mut chunk = vec![0u8; held_capacity()];
    let mut left = stored;
    while left > 0 {
        let take = left.min(chunk.len() as u64) as usize;
        let Some(target) = chunk.get_mut(..take) else {
            break;
        };
        bucket.scratch.read_exact(target)?;
        for triple in target.as_chunks::<TRIPLE_BYTES>().0 {
            visit(le_u32(triple, 0), le_u32(triple, 4), le_u32(triple, 8))?;
        }
        left -= take as u64;
    }
    Ok(())
}

fn drain_bucket(
    mut bucket: Bucket,
    first: u32,
    end: u32,
    first_value: u64,
    offsets: &mut SectionSink,
    values: &mut SectionSink,
) -> Result<u64> {
    if !bucket.held.is_empty() {
        bucket.scratch.append(&bucket.held)?;
        bucket.held = Vec::new();
    }
    let span = end.saturating_sub(first) as usize;
    let mut starts = vec![0u64; span + 1];
    let outside = || save_failed("A removal entry lies outside its scratch file's ordinals".into());
    read_triples(&mut bucket, &mut |ordinal, _, _| {
        let row = ordinal.checked_sub(first).map(|row| row as usize + 1);
        let slot = row
            .filter(|&row| row <= span)
            .and_then(|row| starts.get_mut(row));
        let slot = slot.ok_or_else(outside)?;
        *slot += VALUES_PER_ENTRY;
        Ok(())
    })?;
    for at in 0..span {
        starts[at + 1] += starts[at];
    }
    for &start in starts.iter().take(span) {
        offsets.write_u32(as_value(first_value + start)?)?;
    }
    let total = starts.get(span).copied().unwrap_or(0);
    let mut placed = vec![0u32; usize::try_from(total).map_err(|_| outside())?];
    let mut cursors = starts;
    read_triples(&mut bucket, &mut |ordinal, token, occurrences| {
        let row = ordinal.saturating_sub(first) as usize;
        let cursor = cursors.get_mut(row).ok_or_else(outside)?;
        let at = *cursor as usize;
        let pair = placed.get_mut(at..at + 2).ok_or_else(outside)?;
        pair[0] = token;
        pair[1] = occurrences;
        *cursor += VALUES_PER_ENTRY;
        Ok(())
    })?;
    let mut bytes = Vec::with_capacity(held_capacity());
    for value in placed {
        bytes.extend_from_slice(&value.to_le_bytes());
        if bytes.len() >= held_capacity() {
            values.write(&bytes)?;
            bytes.clear();
        }
    }
    values.write(&bytes)?;
    Ok(first_value + total)
}
