use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use narsil::replication::NodeMemoryReading;
use narsil::{Map, Value};
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::partition_bytes::{PartitionSize, partition_bytes_report};
use super::write_block::NodeMemoryView;
use super::write_pressure::WritePressure;
use crate::constants::{MEMORY_SAMPLE_INTERVAL_MS, WRITE_MEMORY_SAMPLE_MAX_AGE_MS};
use crate::controller::lock;
use crate::coordinator::NodeRegistration;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::ClusterResult;

const MEMORY_FIELD: &str = "memory";
const PARTITION_BYTES_FIELD: &str = "partitionBytes";

pub(crate) type MemorySource = Arc<dyn Fn() -> Option<NodeMemoryReading> + Send + Sync>;
pub(crate) type PartitionSizesSource = Arc<dyn Fn() -> Vec<PartitionSize> + Send + Sync>;

struct Sample {
    reading: Option<NodeMemoryReading>,
    taken_at: Option<Instant>,
}

struct Shared {
    measure: MemorySource,
    local_full: Arc<AtomicBool>,
    sample: Mutex<Sample>,
    full_changed: Notify,
}

impl Shared {
    fn sample(&self) {
        let reading = (self.measure)();
        let full = reading.is_some_and(|reading| reading.full);
        {
            let mut sample = lock(&self.sample);
            sample.reading = reading;
            sample.taken_at = Some(Instant::now());
        }
        if self.local_full.swap(full, Ordering::AcqRel) != full {
            self.full_changed.notify_one();
        }
    }

    fn sample_if_older_than(&self, max_age: Duration) {
        let stale = lock(&self.sample)
            .taken_at
            .is_none_or(|taken_at| taken_at.elapsed() >= max_age);
        if stale {
            self.sample();
        }
    }
}

struct Sampler {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

pub(crate) struct NodeMemory {
    pub(crate) view: NodeMemoryView,
    pub(crate) pressure: WritePressure,
    shared: Arc<Shared>,
    partition_sizes: Option<PartitionSizesSource>,
    sampler: Mutex<Option<Sampler>>,
}

pub(crate) struct NodeMemorySettings {
    pub(crate) node_id: String,
    pub(crate) coordinator: Arc<EtcdCoordinator>,
    pub(crate) measure: MemorySource,
    pub(crate) partition_sizes: Option<PartitionSizesSource>,
    pub(crate) in_flight_write_fraction: f64,
}

fn number(value: u64) -> Value {
    Value::Number(value as f64)
}

fn memory_report(reading: &NodeMemoryReading) -> Value {
    let mut memory = Map::with_capacity(5);
    memory.insert("processBytes", number(reading.process_bytes));
    memory.insert("processLimitBytes", number(reading.process_limit_bytes));
    memory.insert("heapBytes", number(reading.process_bytes));
    memory.insert("heapLimitBytes", number(reading.process_limit_bytes));
    memory.insert("full", Value::Bool(reading.full));
    Value::Object(memory)
}

impl NodeMemory {
    pub(crate) fn new(settings: NodeMemorySettings) -> NodeMemory {
        let local_full = Arc::new(AtomicBool::new(false));
        let heap_limit_bytes = (settings.measure)().map(|reading| reading.process_limit_bytes);
        let limit_bytes = heap_limit_bytes.map_or(u64::MAX, |limit| {
            (limit as f64 * settings.in_flight_write_fraction).floor() as u64
        });
        NodeMemory {
            view: NodeMemoryView::new(
                settings.coordinator,
                settings.node_id.clone(),
                Arc::clone(&local_full),
            ),
            pressure: WritePressure::new(settings.node_id, limit_bytes),
            shared: Arc::new(Shared {
                measure: settings.measure,
                local_full,
                sample: Mutex::new(Sample {
                    reading: None,
                    taken_at: None,
                }),
                full_changed: Notify::new(),
            }),
            partition_sizes: settings.partition_sizes,
            sampler: Mutex::new(None),
        }
    }

    pub(crate) fn before_admit(&self) {
        self.shared
            .sample_if_older_than(Duration::from_millis(WRITE_MEMORY_SAMPLE_MAX_AGE_MS));
    }

    pub(crate) async fn full_changed(&self) {
        self.shared.full_changed.notified().await;
    }

    pub(crate) async fn start(&self) -> ClusterResult<()> {
        if lock(&self.sampler).is_none() {
            self.shared.sample();
            let (stop, mut stopped) = watch::channel(false);
            let shared = Arc::clone(&self.shared);
            let task = tokio::spawn(async move {
                let mut ticks =
                    tokio::time::interval(Duration::from_millis(MEMORY_SAMPLE_INTERVAL_MS));
                ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                ticks.tick().await;
                loop {
                    tokio::select! {
                        _ = ticks.tick() => {}
                        _ = stopped.wait_for(|stopped| *stopped) => return,
                    }
                    let shared = Arc::clone(&shared);
                    if tokio::task::spawn_blocking(move || shared.sample())
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            });
            if let Some(previous) = lock(&self.sampler).replace(Sampler { stop, task }) {
                previous.task.abort();
            }
        }
        self.view.start().await
    }

    pub(crate) async fn stop(&self) {
        let sampler = lock(&self.sampler).take();
        if let Some(sampler) = sampler {
            let _ = sampler.stop.send(true);
            let _ = sampler.task.await;
        }
        self.view.stop();
    }

    pub(crate) async fn current_registration(&self, base: &NodeRegistration) -> NodeRegistration {
        let mut registration = base.clone();
        let reading = lock(&self.shared.sample).reading;
        if let Some(reading) = reading {
            registration
                .extra
                .insert(MEMORY_FIELD, memory_report(&reading));
        }
        let Some(sizes) = self.partition_sizes.clone() else {
            return registration;
        };
        let report = tokio::task::spawn_blocking(move || partition_bytes_report(sizes()))
            .await
            .ok()
            .flatten();
        if let Some(report) = report {
            registration.extra.insert(PARTITION_BYTES_FIELD, report);
        }
        registration
    }
}
