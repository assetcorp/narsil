use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread::ScopedJoinHandle;

use super::constants::{SPREAD_CORE_SHARE_DIVISOR, SPREAD_MIN_DOCUMENTS};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::partition::PartitionSnapshot;
use crate::index::segment::SegmentData;

static SEARCHING_THREADS: AtomicUsize = AtomicUsize::new(0);

struct Searching;

impl Searching {
    fn begin() -> Searching {
        SEARCHING_THREADS.fetch_add(1, Ordering::AcqRel);
        Searching
    }
}

impl Drop for Searching {
    fn drop(&mut self) {
        SEARCHING_THREADS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Runs `search` as one search that the process counts, so that [`each_partition`] adds a thread to it only while
/// the threads that search number fewer than half the host's cores.
pub(crate) fn counted<R>(search: impl FnOnce() -> R) -> R {
    let _searching = Searching::begin();
    search()
}

fn thread_budget() -> usize {
    static BUDGET: OnceLock<usize> = OnceLock::new();
    *BUDGET.get_or_init(|| {
        std::thread::available_parallelism().map_or(1, usize::from) / SPREAD_CORE_SHARE_DIVISOR
    })
}

fn reserve_thread(budget: usize) -> Option<Searching> {
    let mut seen = SEARCHING_THREADS.load(Ordering::Acquire);
    loop {
        if seen >= budget {
            return None;
        }
        match SEARCHING_THREADS.compare_exchange_weak(
            seen,
            seen + 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return Some(Searching),
            Err(now) => seen = now,
        }
    }
}

fn reads_from_files(snapshot: &PartitionSnapshot) -> bool {
    snapshot.segments.iter().any(|entry| match &entry.data {
        SegmentData::Frozen(segment) => segment.paged.is_some(),
        SegmentData::Tail(_) => false,
    })
}

fn spreads(snapshots: &[Arc<PartitionSnapshot>]) -> bool {
    if snapshots.len() < 2 {
        return false;
    }
    let documents: u64 = snapshots
        .iter()
        .map(|snapshot| snapshot.document_count())
        .sum();
    documents >= SPREAD_MIN_DOCUMENTS
        && !snapshots.iter().any(|snapshot| reads_from_files(snapshot))
}

fn stopped() -> NarsilError {
    NarsilError::new(
        ErrorCode::INTERNAL_ERROR,
        "A search thread stopped while it searched one partition of the query",
    )
}

/// Searches every partition with `search` and returns each answer in partition order.
///
/// Where the partitions together hold at least [`SPREAD_MIN_DOCUMENTS`] documents in memory, the calling thread
/// searches the first partition and hands each other partition to a separate thread for as long as the threads that
/// search across the process number fewer than half the host's cores, and it searches the rest itself. A panic on
/// such a thread reaches the caller as `INTERNAL_ERROR` for that partition.
pub(crate) fn each_partition<T, F>(
    snapshots: &[Arc<PartitionSnapshot>],
    search: F,
) -> Vec<Result<T>>
where
    T: Send,
    F: Fn(&PartitionSnapshot) -> Result<T> + Sync,
{
    if !spreads(snapshots) {
        return snapshots.iter().map(|snapshot| search(snapshot)).collect();
    }
    let budget = thread_budget();
    let search = &search;
    std::thread::scope(|scope| {
        let mut handles: Vec<(usize, ScopedJoinHandle<'_, Result<T>>)> = Vec::new();
        let mut answers: Vec<Option<Result<T>>> = snapshots.iter().map(|_| None).collect();
        for (at, snapshot) in snapshots.iter().enumerate().skip(1) {
            let Some(reserved) = reserve_thread(budget) else {
                break;
            };
            let spawned = std::thread::Builder::new()
                .name("narsil-search".to_string())
                .spawn_scoped(scope, move || {
                    let _reserved = reserved;
                    catch_unwind(AssertUnwindSafe(|| search(snapshot)))
                        .unwrap_or_else(|_| Err(stopped()))
                });
            match spawned {
                Ok(handle) => handles.push((at, handle)),
                Err(_) => break,
            }
        }
        for (at, snapshot) in snapshots.iter().enumerate() {
            if handles.iter().all(|(sent, _)| *sent != at)
                && let Some(answer) = answers.get_mut(at)
            {
                *answer = Some(search(snapshot));
            }
        }
        for (at, handle) in handles {
            if let Some(answer) = answers.get_mut(at) {
                *answer = Some(handle.join().unwrap_or_else(|_| Err(stopped())));
            }
        }
        answers
            .into_iter()
            .map(|answer| answer.unwrap_or_else(|| Err(stopped())))
            .collect()
    })
}
