use super::constants::MEGABYTE_BYTES;
use super::{read_process_memory, release_free_pages};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::Value;

const PROCESS_MEMORY_BUDGET: &str = "process";

struct Shortfall {
    needed_bytes: u64,
    available_bytes: u64,
    limit_less_used_bytes: i128,
}

impl Shortfall {
    fn details(&self, index_name: &str) -> [(&'static str, Value); 4] {
        [
            ("indexName", Value::from(index_name)),
            ("budget", Value::from(PROCESS_MEMORY_BUDGET)),
            ("neededBytes", Value::Number(self.needed_bytes as f64)),
            (
                "availableBytes",
                Value::Number(self.limit_less_used_bytes as f64),
            ),
        ]
    }
}

/// Compares `needed_bytes` with the memory that the process has free, or with its whole limit where
/// `counts_in_use` is false, and returns the shortfall where the need passes it. A system that reports no figures
/// leaves the work unchecked.
fn shortfall_of(needed_bytes: u64, counts_in_use: bool) -> Option<Shortfall> {
    let figures = read_process_memory()?;
    let (available_bytes, limit_less_used_bytes) = match counts_in_use {
        true => (
            figures.limit_bytes.saturating_sub(figures.process_bytes),
            i128::from(figures.limit_bytes) - i128::from(figures.process_bytes),
        ),
        false => (figures.limit_bytes, i128::from(figures.limit_bytes)),
    };
    (needed_bytes > available_bytes).then_some(Shortfall {
        needed_bytes,
        available_bytes,
        limit_less_used_bytes,
    })
}

fn megabytes(bytes: u64) -> u64 {
    bytes.div_ceil(MEGABYTE_BYTES)
}

fn shortfall_after_release(needed_bytes: u64, keeps_memory_in_use: bool) -> Option<Shortfall> {
    shortfall_of(needed_bytes, true)?;
    let released = release_free_pages();
    shortfall_of(needed_bytes, released || keeps_memory_in_use)
}

/// Refuses a restore of `index_name` with `RESTORE_MEMORY_EXCEEDED` where loading `footprint_bytes` would pass
/// the process's memory limit, after the allocator hands its free pages back. A restore that `replaces_index`
/// counts the memory in use, which the old index keeps until the swap.
pub(crate) fn require_restore_memory(
    index_name: &str,
    footprint_bytes: u64,
    replaces_index: bool,
) -> Result<()> {
    let Some(shortfall) = shortfall_after_release(footprint_bytes, replaces_index) else {
        return Ok(());
    };
    let outcome = match replaces_index {
        true => {
            "so the index keeps its earlier contents. Drop the index first to free the memory that it holds, or give the process more memory, then restore again"
        }
        false => "so the engine creates no index. Give the process more memory, then restore again",
    };
    Err(NarsilError::new(
        ErrorCode::RESTORE_MEMORY_EXCEEDED,
        format!(
            "The restore of index \"{index_name}\" needs about {} MB of process memory, and this process has {} MB free, {outcome}",
            megabytes(shortfall.needed_bytes),
            megabytes(shortfall.available_bytes)
        ),
    )
    .with_details(shortfall.details(index_name)))
}

/// Refuses an analysis change of `index_name` with `ANALYSIS_REBUILD_MEMORY_EXCEEDED` where a second copy of its
/// `term_bytes` of terms would pass the process's memory limit, after the allocator hands its free pages back.
pub(crate) fn require_analysis_rebuild_memory(index_name: &str, term_bytes: u64) -> Result<()> {
    let Some(shortfall) = shortfall_after_release(term_bytes, false) else {
        return Ok(());
    };
    Err(NarsilError::new(
        ErrorCode::ANALYSIS_REBUILD_MEMORY_EXCEEDED,
        format!(
            "The analysis change of index \"{index_name}\" needs about {} MB of process memory for a second copy of its terms, and this process has {} MB free, so the index keeps its current settings. Give the process more memory, then change the settings again",
            megabytes(shortfall.needed_bytes),
            megabytes(shortfall.available_bytes)
        ),
    )
    .with_details(shortfall.details(index_name)))
}

pub(crate) fn require_reload_memory(
    index_name: &str,
    partition: u32,
    needed_bytes: u64,
) -> Result<()> {
    let Some(shortfall) = shortfall_after_release(needed_bytes, true) else {
        return Ok(());
    };
    let details = shortfall
        .details(index_name)
        .into_iter()
        .chain([("partitionId", Value::from(partition))]);
    Err(NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!(
            "Partition {partition} of index \"{index_name}\" needs about {} MB more process memory to read its checkpoint again, and this process has {} MB free, so the partition stays failed. Give the process more memory, then reload the partition again",
            megabytes(shortfall.needed_bytes),
            megabytes(shortfall.available_bytes)
        ),
    )
    .with_details(details))
}
