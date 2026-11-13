mod budget;
pub(crate) mod constants;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use super::engine_config::MemoryFractions;
use crate::error::{ErrorCode, NarsilError, Result};
pub(crate) use budget::{require_analysis_rebuild_memory, require_restore_memory};
use constants::{FREE_PAGE_RELEASE_INTERVAL_MS, MEMORY_FIGURES_MAX_AGE_MS};

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;

/// The resident memory of this process that no file backs, and the memory that it may use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProcessMemory {
    pub(crate) process_bytes: u64,
    pub(crate) limit_bytes: u64,
}

impl ProcessMemory {
    fn fraction(&self) -> f64 {
        self.process_bytes as f64 / self.limit_bytes as f64
    }
}

/// Reads the resident memory of this process that no file backs and its limit, or returns `None` on a system that
/// reports neither.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub(crate) fn read_process_memory() -> Option<ProcessMemory> {
    let process_bytes = platform::process_bytes()?;
    let limit_bytes = platform::limit_bytes(process_bytes).filter(|bytes| *bytes > 0)?;
    Some(ProcessMemory {
        process_bytes,
        limit_bytes,
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn read_process_memory() -> Option<ProcessMemory> {
    None
}

/// Hands the allocator's free pages back to the system where the allocator allows it, and reports whether any
/// went back.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub(crate) fn release_free_pages() -> bool {
    platform::release_free_pages()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn release_free_pages() -> bool {
    false
}

struct Reading {
    released_at: Option<Instant>,
    latest: Option<ProcessMemory>,
    full: bool,
}

/// The memory levels at which an engine stops and resumes accepting inserts and updates, with its latest
/// reading of the process's memory.
///
/// A write reads two atomics while the last reading is fresh and the engine is not full, and takes the lock of
/// the reading only to measure again.
pub(crate) struct MemoryGuard {
    fractions: MemoryFractions,
    epoch: Instant,
    measured_at_ms: AtomicU64,
    full: AtomicBool,
    reading: Mutex<Reading>,
}

const NEVER_MEASURED: u64 = u64::MAX;

fn next_full(was_full: bool, figures: &ProcessMemory, fractions: &MemoryFractions) -> bool {
    match was_full {
        true => figures.fraction() >= fractions.resume,
        false => figures.fraction() > fractions.block,
    }
}

fn megabytes(bytes: u64) -> u64 {
    bytes.div_ceil(constants::MEGABYTE_BYTES)
}

impl MemoryGuard {
    pub(crate) fn new(fractions: MemoryFractions) -> MemoryGuard {
        MemoryGuard {
            fractions,
            epoch: Instant::now(),
            measured_at_ms: AtomicU64::new(NEVER_MEASURED),
            full: AtomicBool::new(false),
            reading: Mutex::new(Reading {
                released_at: None,
                latest: None,
                full: false,
            }),
        }
    }

    fn now_ms(&self) -> u64 {
        u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(NEVER_MEASURED - 1)
    }

    fn fresh(&self) -> bool {
        let measured_at = self.measured_at_ms.load(Ordering::Acquire);
        measured_at != NEVER_MEASURED
            && self.now_ms().saturating_sub(measured_at) < MEMORY_FIGURES_MAX_AGE_MS
    }

    fn measure(&self, reading: &mut Reading) {
        self.measure_figures(reading);
        self.full.store(reading.full, Ordering::Release);
        self.measured_at_ms.store(self.now_ms(), Ordering::Release);
    }

    fn measure_figures(&self, reading: &mut Reading) {
        let Some(mut figures) = read_process_memory() else {
            reading.latest = None;
            reading.full = false;
            return;
        };
        let mut full = next_full(reading.full, &figures, &self.fractions);
        let release_due = reading
            .released_at
            .is_none_or(|at| at.elapsed() >= Duration::from_millis(FREE_PAGE_RELEASE_INTERVAL_MS));
        if full && release_due {
            reading.released_at = Some(Instant::now());
            if release_free_pages()
                && let Some(after) = read_process_memory()
            {
                figures = after;
                full = next_full(reading.full, &figures, &self.fractions);
            }
        }
        reading.latest = Some(figures);
        reading.full = full;
    }

    /// Refuses an insert or an update of `index_name` with `MEMORY_WRITE_BLOCKED` while the process's resident
    /// memory that no file backs stands above the block level, reading the memory again where the last reading is
    /// more than a second old, and once more before it refuses.
    pub(crate) fn refuse_while_full(&self, index_name: &str) -> Result<()> {
        if self.fresh() && !self.full.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut reading = self
            .reading
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !self.fresh() {
            self.measure(&mut reading);
        }
        if !reading.full {
            return Ok(());
        }
        self.measure(&mut reading);
        let (true, Some(figures)) = (reading.full, reading.latest) else {
            return Ok(());
        };
        Err(NarsilError::new(
            ErrorCode::MEMORY_WRITE_BLOCKED,
            format!(
                "The engine refuses inserts and updates to index '{index_name}' because its memory passed the block level of its limit ({} MB of {} MB). Remove documents to free memory, and writes resume once memory falls below the resume level.",
                megabytes(figures.process_bytes),
                megabytes(figures.limit_bytes)
            ),
        ))
    }

    /// Makes the next write read the memory again, once a remove or a drop has freed some while the engine is
    /// full.
    pub(crate) fn memory_released(&self) {
        let mut reading = self
            .reading
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if reading.full {
            reading.released_at = None;
            self.measured_at_ms.store(NEVER_MEASURED, Ordering::Release);
        }
    }
}
