use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use narsil::Value;

use crate::controller::{IndexMetadata, index_metadata_of, lock, stored_index_metadata};
use crate::coordinator::etcd::{EtcdCoordinator, WatchHandle};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::node::{NodeErrorHandler, report_failure};

#[derive(Debug, Clone, PartialEq, Eq)]
struct HeldGeneration {
    index_uuid: String,
    generation: u64,
}

pub(crate) fn analysis_generation_of(settings: Option<&Value>) -> u64 {
    let Some(Value::Object(settings)) = settings else {
        return 0;
    };
    match settings.get("analysisGeneration") {
        Some(Value::Number(generation))
            if generation.is_finite() && generation.fract() == 0.0 && *generation >= 0.0 =>
        {
            *generation as u64
        }
        _ => 0,
    }
}

pub(crate) struct AnalysisView {
    coordinator: Arc<EtcdCoordinator>,
    on_error: Option<NodeErrorHandler>,
    held: Arc<Mutex<HashMap<String, HeldGeneration>>>,
    watch: Mutex<Option<WatchHandle>>,
}

fn record_generation(
    held: &Mutex<HashMap<String, HeldGeneration>>,
    index_name: &str,
    record: &IndexMetadata,
    settings: Option<&Value>,
) -> u64 {
    let generation = analysis_generation_of(settings);
    let mut held = lock(held);
    if let Some(known) = held.get(index_name)
        && known.index_uuid == record.index_uuid
        && known.generation >= generation
    {
        return known.generation;
    }
    held.insert(
        index_name.to_string(),
        HeldGeneration {
            index_uuid: record.index_uuid.clone(),
            generation,
        },
    );
    generation
}

impl AnalysisView {
    pub(crate) fn new(
        coordinator: Arc<EtcdCoordinator>,
        on_error: Option<NodeErrorHandler>,
    ) -> AnalysisView {
        AnalysisView {
            coordinator,
            on_error,
            held: Arc::new(Mutex::new(HashMap::new())),
            watch: Mutex::new(None),
        }
    }

    pub(crate) fn held(&self, index_name: &str) -> Option<u64> {
        lock(&self.held)
            .get(index_name)
            .map(|known| known.generation)
    }

    pub(crate) async fn refresh(&self, index_name: &str) -> ClusterResult<u64> {
        let Some((record, settings)) = stored_index_metadata(&self.coordinator, index_name).await?
        else {
            lock(&self.held).remove(index_name);
            return Ok(0);
        };
        Ok(record_generation(
            &self.held,
            index_name,
            &record,
            settings.as_ref(),
        ))
    }

    pub(crate) async fn generation_for(&self, index_name: &str) -> ClusterResult<u64> {
        match self.held(index_name) {
            Some(generation) => Ok(generation),
            None => self.refresh(index_name).await,
        }
    }

    pub(crate) async fn start(&self) -> ClusterResult<()> {
        if lock(&self.watch).is_some() {
            return Ok(());
        }
        let held = Arc::clone(&self.held);
        let on_error = self.on_error.clone();
        let handle = self
            .coordinator
            .watch_index_metadata(move |event| {
                let Some(metadata) = event.metadata else {
                    lock(&held).remove(&event.index_name);
                    return;
                };
                match index_metadata_of(&metadata, &event.index_name) {
                    Ok(Some((record, settings))) => {
                        record_generation(&held, &event.index_name, &record, settings.as_ref());
                    }
                    Ok(None) => {}
                    Err(error) => report_failure(on_error.as_ref(), &error),
                }
            })
            .await?;
        if let Some(previous) = lock(&self.watch).replace(handle) {
            previous.stop();
        }
        for index_name in self.coordinator.list_schemas().await? {
            if lock(&self.watch).is_none() {
                return Ok(());
            }
            if self.held(&index_name).is_none()
                && let Err(error) = self.refresh(&index_name).await
            {
                report_failure(self.on_error.as_ref(), &error);
            }
        }
        Ok(())
    }

    pub(crate) fn stop(&self) {
        if let Some(handle) = lock(&self.watch).take() {
            handle.stop();
        }
        lock(&self.held).clear();
    }
}

pub(crate) fn generation_missing(error: &ClusterError) -> bool {
    error.code() == codes::ANALYSIS_GENERATION_MISSING
}
