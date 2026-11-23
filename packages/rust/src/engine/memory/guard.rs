use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use super::constants::{
    FREE_PAGE_RELEASE_INTERVAL_MS, MEGABYTE_BYTES, MEMORY_FIGURES_MAX_AGE_MS,
    RECENT_MEMORY_FIGURES_MAX_ADMITTED_FRACTION, REFUSAL_PAGE_RELEASE_MIN_INTERVAL_MS,
    REFUSAL_PAGE_RELEASE_TIME_MULTIPLE,
};
use super::{ProcessMemory, read_process_memory, release_free_pages};
use crate::engine::engine_config::MemoryFractions;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::Value;

const MEMORY_FULL_REASON: &str = "memory_full";
const NEVER_MEASURED: u64 = u64::MAX;
const NO_LIMIT: u64 = 0;

struct RefusalRelease {
    released_at: Option<Instant>,
    interval: Duration,
}

struct Reading {
    released_at: Option<Instant>,
    latest: Option<ProcessMemory>,
    full: bool,
    refusal_release: RefusalRelease,
    releases: u64,
}

/// The memory levels at which an engine stops and resumes accepting inserts and updates, with its latest
/// reading of the process's memory.
///
/// A write reads two atomics while the last reading is fresh and the engine is not full, and takes the lock of
/// the reading only to measure again.
pub(crate) struct MemoryGuard {
    pub(crate) fractions: MemoryFractions,
    epoch: Instant,
    measured_at_ms: AtomicU64,
    full: AtomicBool,
    latest_process_bytes: AtomicU64,
    latest_limit_bytes: AtomicU64,
    reserved_bytes: AtomicU64,
    admitted_bytes: AtomicU64,
    admitted_at_measurement: AtomicU64,
    reading: Mutex<Reading>,
}

fn next_full(was_full: bool, figures: &ProcessMemory, fractions: &MemoryFractions) -> bool {
    match was_full {
        true => figures.fraction() >= fractions.resume,
        false => figures.fraction() > fractions.block,
    }
}

fn megabytes(bytes: u64) -> u64 {
    bytes.div_ceil(MEGABYTE_BYTES)
}

impl MemoryGuard {
    pub(crate) fn new(fractions: MemoryFractions) -> MemoryGuard {
        MemoryGuard {
            fractions,
            epoch: Instant::now(),
            measured_at_ms: AtomicU64::new(NEVER_MEASURED),
            full: AtomicBool::new(false),
            latest_process_bytes: AtomicU64::new(0),
            latest_limit_bytes: AtomicU64::new(NO_LIMIT),
            reserved_bytes: AtomicU64::new(0),
            admitted_bytes: AtomicU64::new(0),
            admitted_at_measurement: AtomicU64::new(0),
            reading: Mutex::new(Reading {
                released_at: None,
                latest: None,
                full: false,
                refusal_release: RefusalRelease {
                    released_at: None,
                    interval: Duration::from_millis(REFUSAL_PAGE_RELEASE_MIN_INTERVAL_MS),
                },
                releases: 0,
            }),
        }
    }

    fn reading(&self) -> std::sync::MutexGuard<'_, Reading> {
        self.reading
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
        self.measured_at_ms.store(NEVER_MEASURED, Ordering::Release);
        self.admitted_at_measurement.store(
            self.admitted_bytes.load(Ordering::Acquire),
            Ordering::Release,
        );
        self.measure_figures(reading);
        let (process_bytes, limit_bytes) = reading.latest.map_or((0, NO_LIMIT), |latest| {
            (latest.process_bytes, latest.limit_bytes)
        });
        self.latest_process_bytes
            .store(process_bytes, Ordering::Release);
        self.latest_limit_bytes
            .store(limit_bytes, Ordering::Release);
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

    pub(crate) fn refuse_while_full(&self, index_name: &str) -> Result<()> {
        if self.fresh() && !self.full.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut reading = self.reading();
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
        )
        .with_details([
            ("reason", Value::from(MEMORY_FULL_REASON)),
            ("indexName", Value::from(index_name)),
            ("processBytes", Value::Number(figures.process_bytes as f64)),
            ("processLimitBytes", Value::Number(figures.limit_bytes as f64)),
            ("heapBytes", Value::Null),
            ("heapLimitBytes", Value::Null),
        ]))
    }

    /// Makes the next write read the memory again, once a remove or a drop has freed some while the engine is
    /// full.
    pub(crate) fn memory_released(&self) {
        let mut reading = self.reading();
        if reading.full {
            reading.released_at = None;
            self.measured_at_ms.store(NEVER_MEASURED, Ordering::Release);
        }
    }

    pub(crate) fn reserved_bytes(&self) -> u64 {
        self.reserved_bytes.load(Ordering::Acquire)
    }

    pub(crate) fn reserve_if_unchanged(&self, reserved_before: u64, bytes: u64) -> bool {
        let reserved = self
            .reserved_bytes
            .compare_exchange(
                reserved_before,
                reserved_before.saturating_add(bytes),
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok();
        if reserved {
            self.admitted_bytes.fetch_add(bytes, Ordering::AcqRel);
        }
        reserved
    }

    pub(crate) fn release(&self, bytes: u64) {
        self.reserved_bytes.fetch_sub(bytes, Ordering::AcqRel);
    }

    fn recent_figures(&self) -> Option<ProcessMemory> {
        let process_bytes = self.latest_process_bytes.load(Ordering::Acquire);
        let limit_bytes = self.latest_limit_bytes.load(Ordering::Acquire);
        let since = self
            .admitted_bytes
            .load(Ordering::Acquire)
            .saturating_sub(self.admitted_at_measurement.load(Ordering::Acquire));
        let recent = self.fresh()
            && limit_bytes != NO_LIMIT
            && since as f64 <= RECENT_MEMORY_FIGURES_MAX_ADMITTED_FRACTION * limit_bytes as f64;
        recent.then_some(ProcessMemory {
            process_bytes: process_bytes.saturating_add(since),
            limit_bytes,
        })
    }

    pub(crate) fn write_figures(&self) -> Option<ProcessMemory> {
        if let Some(recent) = self.recent_figures() {
            return Some(recent);
        }
        let mut reading = self.reading();
        if let Some(recent) = self.recent_figures() {
            return Some(recent);
        }
        self.measure(&mut reading);
        let latest = reading.latest?;
        let since = self
            .admitted_bytes
            .load(Ordering::Acquire)
            .saturating_sub(self.admitted_at_measurement.load(Ordering::Acquire));
        Some(ProcessMemory {
            process_bytes: latest.process_bytes.saturating_add(since),
            limit_bytes: latest.limit_bytes,
        })
    }

    pub(crate) fn measure_after_release(&self) -> Option<ProcessMemory> {
        let mut reading = self.reading();
        let due = reading
            .refusal_release
            .released_at
            .is_none_or(|at| at.elapsed() >= reading.refusal_release.interval);
        if due {
            let started = Instant::now();
            reading.refusal_release.released_at = Some(started);
            if release_free_pages() {
                reading.releases = reading.releases.saturating_add(1);
                reading.refusal_release.interval =
                    Duration::from_millis(REFUSAL_PAGE_RELEASE_MIN_INTERVAL_MS).max(
                        started
                            .elapsed()
                            .saturating_mul(REFUSAL_PAGE_RELEASE_TIME_MULTIPLE),
                    );
            }
        }
        self.measure(&mut reading);
        reading.latest
    }

    pub(crate) fn admit(&self, bytes: u64) {
        self.admitted_bytes.fetch_add(bytes, Ordering::AcqRel);
    }

    pub(crate) fn measure_now(&self) -> Option<ProcessMemory> {
        let mut reading = self.reading();
        self.measure(&mut reading);
        reading.latest
    }

    pub(crate) fn is_full(&self) -> bool {
        self.full.load(Ordering::Acquire)
    }

    pub(crate) fn releases(&self) -> u64 {
        self.reading().releases
    }

    pub(crate) fn refused_after_release(&self, figures: &ProcessMemory) {
        let mut reading = self.reading();
        if reading.full || figures.fraction() < self.fractions.resume {
            return;
        }
        reading.latest = Some(*figures);
        reading.full = true;
        self.full.store(true, Ordering::Release);
    }
}
