use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use narsil::Value;

use super::projection::{VectorReadSettings, vector_field_segments_of};
use crate::allocator::Table;
use crate::controller::{index_metadata_of, lock, stored_index_metadata};
use crate::coordinator::SchemaEvent;
use crate::coordinator::etcd::{EtcdCoordinator, WatchHandle};
use crate::error::ClusterResult;
use crate::node::{NodeErrorHandler, report_failure};

#[derive(Debug, Clone)]
struct HeldReturnVectors {
    index_uuid: String,
    return_vectors: bool,
}

#[derive(Debug, Clone)]
struct HeldVectorSettings {
    index_uuid: String,
    settings: VectorReadSettings,
}

fn return_vectors_of(settings: Option<&Value>) -> bool {
    matches!(settings, Some(Value::Object(settings)) if settings.get("returnVectors") == Some(&Value::Bool(true)))
}

#[derive(Default)]
struct Held {
    schemas: HashMap<String, Value>,
    metadata: HashMap<String, HeldReturnVectors>,
    settled: HashMap<String, HeldVectorSettings>,
}

impl Held {
    fn settle(&mut self, index_name: &str) {
        match (self.schemas.get(index_name), self.metadata.get(index_name)) {
            (Some(schema), Some(known)) => {
                let settled = HeldVectorSettings {
                    index_uuid: known.index_uuid.clone(),
                    settings: VectorReadSettings {
                        vector_fields: vector_field_segments_of(schema),
                        return_vectors: known.return_vectors,
                    },
                };
                self.settled.insert(index_name.to_string(), settled);
            }
            _ => {
                self.settled.remove(index_name);
            }
        }
    }
}

pub(crate) struct VectorReadView {
    coordinator: Arc<EtcdCoordinator>,
    on_error: Option<NodeErrorHandler>,
    held: Arc<Mutex<Held>>,
    events_received: Arc<AtomicU64>,
    watching: AtomicBool,
    watches: Mutex<Vec<WatchHandle>>,
}

fn serves_allocation(held: &HeldVectorSettings, table: &Table) -> bool {
    table
        .index_uuid
        .as_deref()
        .is_none_or(|index_uuid| index_uuid == held.index_uuid)
}

impl VectorReadView {
    pub(crate) fn new(
        coordinator: Arc<EtcdCoordinator>,
        on_error: Option<NodeErrorHandler>,
    ) -> VectorReadView {
        VectorReadView {
            coordinator,
            on_error,
            held: Arc::new(Mutex::new(Held::default())),
            events_received: Arc::new(AtomicU64::new(0)),
            watching: AtomicBool::new(false),
            watches: Mutex::new(Vec::new()),
        }
    }

    async fn read_live(&self, index_name: &str) -> ClusterResult<Option<HeldVectorSettings>> {
        let events_before = self.events_received.load(Ordering::Acquire);
        let (schema, snapshot) = tokio::join!(
            self.coordinator.schema(index_name),
            stored_index_metadata(&self.coordinator, index_name)
        );
        let (Some(schema), Some((record, settings))) = (schema?, snapshot?) else {
            return Ok(None);
        };
        let return_vectors = return_vectors_of(settings.as_ref());
        let live = HeldVectorSettings {
            index_uuid: record.index_uuid.clone(),
            settings: VectorReadSettings {
                vector_fields: vector_field_segments_of(&schema),
                return_vectors,
            },
        };
        if self.watching.load(Ordering::Acquire)
            && self.events_received.load(Ordering::Acquire) == events_before
        {
            let mut held = lock(&self.held);
            held.schemas.insert(index_name.to_string(), schema);
            held.metadata.insert(
                index_name.to_string(),
                HeldReturnVectors {
                    index_uuid: record.index_uuid,
                    return_vectors,
                },
            );
            held.settled.insert(index_name.to_string(), live.clone());
        }
        Ok(Some(live))
    }

    pub(crate) async fn settings_of(
        &self,
        index_name: &str,
        table: &Table,
    ) -> ClusterResult<VectorReadSettings> {
        let held = lock(&self.held).settled.get(index_name).cloned();
        if self.watching.load(Ordering::Acquire)
            && let Some(held) = &held
            && serves_allocation(held, table)
        {
            return Ok(held.settings.clone());
        }
        match self.read_live(index_name).await {
            Ok(live) => Ok(live.map(|live| live.settings).unwrap_or_default()),
            Err(error) => match held {
                Some(held) => Ok(held.settings),
                None => Err(error),
            },
        }
    }

    pub(crate) async fn start(&self) -> ClusterResult<()> {
        if self.watching.load(Ordering::Acquire) {
            return Ok(());
        }
        let held = Arc::clone(&self.held);
        let events = Arc::clone(&self.events_received);
        let schemas = self
            .coordinator
            .watch_schemas(move |event| {
                events.fetch_add(1, Ordering::AcqRel);
                let mut held = lock(&held);
                match event {
                    SchemaEvent::Created { index_name, schema } => {
                        held.schemas.insert(index_name.clone(), schema);
                        held.settle(&index_name);
                    }
                    SchemaEvent::Dropped { index_name } => {
                        held.schemas.remove(&index_name);
                        held.settle(&index_name);
                    }
                }
            })
            .await?;
        lock(&self.watches).push(schemas);
        let held = Arc::clone(&self.held);
        let events = Arc::clone(&self.events_received);
        let on_error = self.on_error.clone();
        let metadata = self
            .coordinator
            .watch_index_metadata(move |event| {
                events.fetch_add(1, Ordering::AcqRel);
                let next = match event.metadata {
                    None => None,
                    Some(bytes) => match index_metadata_of(&bytes, &event.index_name) {
                        Ok(decoded) => decoded.map(|(record, settings)| HeldReturnVectors {
                            index_uuid: record.index_uuid,
                            return_vectors: return_vectors_of(settings.as_ref()),
                        }),
                        Err(error) => {
                            report_failure(on_error.as_ref(), &error);
                            None
                        }
                    },
                };
                let mut held = lock(&held);
                match next {
                    Some(next) => {
                        held.metadata.insert(event.index_name.clone(), next);
                    }
                    None => {
                        held.metadata.remove(&event.index_name);
                    }
                }
                held.settle(&event.index_name);
            })
            .await;
        match metadata {
            Ok(handle) => lock(&self.watches).push(handle),
            Err(error) => {
                self.stop();
                return Err(error);
            }
        }
        self.watching.store(true, Ordering::Release);
        for index_name in self.coordinator.list_schemas().await? {
            if !self.watching.load(Ordering::Acquire) {
                return Ok(());
            }
            if lock(&self.held).settled.contains_key(&index_name) {
                continue;
            }
            if let Err(error) = self.read_live(&index_name).await {
                report_failure(self.on_error.as_ref(), &error);
            }
        }
        Ok(())
    }

    pub(crate) fn stop(&self) {
        self.watching.store(false, Ordering::Release);
        for watch in lock(&self.watches).drain(..) {
            watch.stop();
        }
        let mut held = lock(&self.held);
        held.schemas.clear();
        held.metadata.clear();
        held.settled.clear();
    }
}
