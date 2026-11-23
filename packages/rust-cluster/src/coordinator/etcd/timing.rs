use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::EtcdCoordinator;
use crate::constants::COORDINATOR_REQUEST_BUCKET_BOUNDS_SECONDS;

/// How long the calls of one coordinator operation took, which `/metrics` reports as a histogram.
#[derive(Debug, Clone, PartialEq)]
pub struct CoordinatorRequestFigure {
    /// The operation, under the name that a TypeScript coordinator gives the same call, such as `getAllocation`.
    pub operation: String,
    /// The upper bound of each bucket, in seconds.
    pub bucket_bounds_seconds: Vec<f64>,
    /// The number of calls that took at most the bound at the same position.
    pub bucket_counts: Vec<u64>,
    /// The number of calls.
    pub count: u64,
    /// The seconds that every call took, added together.
    pub sum_seconds: f64,
}

struct OperationTiming {
    bucket_counts: [u64; COORDINATOR_REQUEST_BUCKET_BOUNDS_SECONDS.len()],
    count: u64,
    sum_seconds: f64,
}

#[derive(Default)]
pub(crate) struct CoordinatorTiming {
    operations: Mutex<BTreeMap<String, OperationTiming>>,
}

fn held<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl CoordinatorTiming {
    pub(crate) fn record(&self, operation: &str, elapsed: Duration) {
        let seconds = elapsed.as_secs_f64();
        let mut operations = held(&self.operations);
        if !operations.contains_key(operation) {
            operations.insert(
                operation.to_string(),
                OperationTiming {
                    bucket_counts: [0; COORDINATOR_REQUEST_BUCKET_BOUNDS_SECONDS.len()],
                    count: 0,
                    sum_seconds: 0.0,
                },
            );
        }
        let Some(timing) = operations.get_mut(operation) else {
            return;
        };
        for (position, bound) in COORDINATOR_REQUEST_BUCKET_BOUNDS_SECONDS.iter().enumerate() {
            if seconds <= *bound {
                timing.bucket_counts[position] += 1;
            }
        }
        timing.count += 1;
        timing.sum_seconds += seconds;
    }

    fn figures(&self) -> Vec<CoordinatorRequestFigure> {
        held(&self.operations)
            .iter()
            .map(|(operation, timing)| CoordinatorRequestFigure {
                operation: operation.clone(),
                bucket_bounds_seconds: COORDINATOR_REQUEST_BUCKET_BOUNDS_SECONDS.to_vec(),
                bucket_counts: timing.bucket_counts.to_vec(),
                count: timing.count,
                sum_seconds: timing.sum_seconds,
            })
            .collect()
    }
}

impl EtcdCoordinator {
    pub(super) fn timed<'a, T>(
        &'a self,
        operation: &'a str,
        work: impl Future<Output = T> + 'a,
    ) -> impl Future<Output = T> + 'a {
        let work = Box::pin(work);
        async move {
            let started = Instant::now();
            let outcome = work.await;
            self.inner.pool.timing.record(operation, started.elapsed());
            outcome
        }
    }

    /// Returns how long this coordinator's calls took, one histogram for each operation, ordered by the operation's
    /// name. Each call of a coordinator method counts once, however many requests it sent to etcd, and a watch
    /// counts in no histogram.
    pub fn request_figures(&self) -> Vec<CoordinatorRequestFigure> {
        self.inner.pool.timing.figures()
    }
}
