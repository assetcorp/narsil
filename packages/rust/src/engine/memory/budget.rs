use super::constants::MEGABYTE_BYTES;
use super::{read_process_memory, release_free_pages};
use crate::error::{ErrorCode, NarsilError, Result};

struct Shortfall {
    needed_bytes: u64,
    available_bytes: u64,
}

/// Compares `needed_bytes` with the memory that the process has free, or with its whole limit where
/// `counts_in_use` is false, and returns the shortfall where the need passes it. A system that reports no figures
/// leaves the work unchecked.
fn shortfall_of(needed_bytes: u64, counts_in_use: bool) -> Option<Shortfall> {
    let figures = read_process_memory()?;
    let available_bytes = match counts_in_use {
        true => figures.limit_bytes.saturating_sub(figures.process_bytes),
        false => figures.limit_bytes,
    };
    (needed_bytes > available_bytes).then_some(Shortfall {
        needed_bytes,
        available_bytes,
    })
}

fn megabytes(bytes: u64) -> u64 {
    bytes.div_ceil(MEGABYTE_BYTES)
}

/// Refuses a restore of `index_name` with `RESTORE_MEMORY_EXCEEDED` where loading `footprint_bytes` would pass
/// the process's memory limit, after the allocator hands its free pages back. A restore that `replaces_index`
/// counts the memory in use, which the old index keeps until the swap.
pub(crate) fn require_restore_memory(
    index_name: &str,
    footprint_bytes: u64,
    replaces_index: bool,
) -> Result<()> {
    if shortfall_of(footprint_bytes, true).is_none() {
        return Ok(());
    }
    let released = release_free_pages();
    let Some(shortfall) = shortfall_of(footprint_bytes, released || replaces_index) else {
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
    ))
}

/// Refuses an analysis change of `index_name` with `ANALYSIS_REBUILD_MEMORY_EXCEEDED` where a second copy of its
/// `term_bytes` of terms would pass the process's memory limit, after the allocator hands its free pages back.
pub(crate) fn require_analysis_rebuild_memory(index_name: &str, term_bytes: u64) -> Result<()> {
    if shortfall_of(term_bytes, true).is_none() {
        return Ok(());
    }
    let released = release_free_pages();
    let Some(shortfall) = shortfall_of(term_bytes, released) else {
        return Ok(());
    };
    Err(NarsilError::new(
        ErrorCode::ANALYSIS_REBUILD_MEMORY_EXCEEDED,
        format!(
            "The analysis change of index \"{index_name}\" needs about {} MB of process memory for a second copy of its terms, and this process has {} MB free, so the index keeps its current settings. Give the process more memory, then change the settings again",
            megabytes(shortfall.needed_bytes),
            megabytes(shortfall.available_bytes)
        ),
    ))
}
