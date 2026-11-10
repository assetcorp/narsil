use std::collections::{BTreeMap, VecDeque};

use crate::error::Result;
use crate::format::archive::{ARCHIVE_CONFIG_ENTRY, ARCHIVE_MANIFEST_ENTRY};
use crate::format::archive_tar::{tar_end, tar_entry_headers, tar_padding};

use super::files::DurableDirectory;
use super::log_reader::list_segments;
use super::sync_files::{HistorySegment, PublishedSnapshot, list_history};

/// How much history a synced index keeps: segments moved in no longer ago than `max_age_ms`, holding no more
/// than `max_bytes` in all.
pub(crate) struct HistoryLimits {
    pub(crate) max_age_ms: u64,
    pub(crate) max_bytes: u64,
}

struct SizedSegment {
    segment: HistorySegment,
    bytes: u64,
    last_seq_no: u64,
}

fn entry_bytes(name: &str, size: u64) -> u64 {
    tar_entry_headers(name, size).len() as u64 + size + tar_padding(size).len() as u64
}

/// Returns the length of the snapshot archive of a published snapshot, which a device downloads.
pub(crate) fn published_archive_bytes(published: &PublishedSnapshot, index_name: &str) -> u64 {
    let prefix = format!("{index_name}/");
    let mut total = entry_bytes(ARCHIVE_CONFIG_ENTRY, published.config.len() as u64)
        + entry_bytes(
            ARCHIVE_MANIFEST_ENTRY,
            published.manifest_bytes.len() as u64,
        );
    for file in published.manifest.file_refs() {
        let name = file.key.strip_prefix(&prefix).unwrap_or(&file.key);
        total = total.saturating_add(entry_bytes(name, file.bytes));
    }
    total.saturating_add(tar_end().len() as u64)
}

fn sized_queues(
    directory: &DurableDirectory,
    index_name: &str,
) -> Result<BTreeMap<u32, VecDeque<SizedSegment>>> {
    let mut queues: BTreeMap<u32, VecDeque<SizedSegment>> = BTreeMap::new();
    for segment in list_history(directory, index_name, None)? {
        let Some(bytes) = directory.byte_length(&segment.key)? else {
            continue;
        };
        queues
            .entry(segment.partition_id)
            .or_default()
            .push_back(SizedSegment {
                segment,
                bytes,
                last_seq_no: u64::MAX,
            });
    }
    for (&partition_id, queue) in queues.iter_mut() {
        let log_start = list_segments(directory, index_name, partition_id)?
            .first()
            .map(|segment| segment.start_seq_no);
        let starts: Vec<Option<u64>> = queue
            .iter()
            .skip(1)
            .map(|next| Some(next.segment.start_seq_no))
            .chain(std::iter::once(log_start))
            .collect();
        for (sized, next_start) in queue.iter_mut().zip(starts) {
            sized.last_seq_no = next_start.map_or(u64::MAX, |start| start.saturating_sub(1));
        }
    }
    Ok(queues)
}

fn next_to_delete(
    queues: &BTreeMap<u32, VecDeque<SizedSegment>>,
    total_bytes: u64,
    limits: &HistoryLimits,
    now_ms: u64,
) -> Option<u32> {
    let oldest_kept = now_ms.saturating_sub(limits.max_age_ms);
    let mut oldest: Option<(u32, u64)> = None;
    for (&partition_id, queue) in queues {
        let Some(head) = queue.front() else {
            continue;
        };
        if oldest.is_none_or(|(_, moved)| head.segment.moved_at_ms < moved) {
            oldest = Some((partition_id, head.segment.moved_at_ms));
        }
    }
    let (partition_id, moved_at_ms) = oldest?;
    (moved_at_ms < oldest_kept || total_bytes > limits.max_bytes).then_some(partition_id)
}

/// Deletes the oldest history segment of an index, oldest first, while one is older than the age limit or the
/// history holds more bytes than the byte limit, and returns how many it deleted.
///
/// Before it deletes a segment that holds an entry above the published snapshot's last sequence number for that
/// partition, or any segment while the index has no published snapshot, it calls `publish` once, so that a
/// device that falls behind the history can still start from the published snapshot.
pub(crate) fn enforce_history_limits(
    directory: &DurableDirectory,
    index_name: &str,
    limits: &HistoryLimits,
    now_ms: u64,
    mut published: Option<PublishedSnapshot>,
    publish: &mut dyn FnMut() -> Result<PublishedSnapshot>,
) -> Result<usize> {
    let mut queues = sized_queues(directory, index_name)?;
    let mut total_bytes: u64 = queues
        .values()
        .flatten()
        .map(|sized| sized.bytes)
        .fold(0, u64::saturating_add);
    let mut republished = false;
    let mut deleted = 0;
    while let Some(partition_id) = next_to_delete(&queues, total_bytes, limits, now_ms) {
        let Some(queue) = queues.get_mut(&partition_id) else {
            break;
        };
        let Some(head) = queue.front() else {
            break;
        };
        let published_last = published
            .as_ref()
            .map(|snapshot| snapshot.last_seq_no(partition_id));
        if !republished && published_last.is_none_or(|last| head.last_seq_no > last) {
            republished = true;
            published = Some(publish()?);
        }
        directory.remove(&head.segment.key)?;
        total_bytes = total_bytes.saturating_sub(head.bytes);
        queue.pop_front();
        deleted += 1;
    }
    Ok(deleted)
}
