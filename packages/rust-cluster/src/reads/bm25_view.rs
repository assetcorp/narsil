use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use narsil::Value;

use crate::controller::{IndexMetadata, index_metadata_of, lock, stored_index_metadata};
use crate::coordinator::etcd::{EtcdCoordinator, WatchHandle};
use crate::error::ClusterResult;
use crate::node::{NodeErrorHandler, report_failure};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HeldBm25Setting {
    pub(crate) index_uuid: String,
    pub(crate) bm25: Option<Value>,
    pub(crate) revision: Option<u64>,
}

fn setting_of(record: &IndexMetadata, settings: Option<&Value>) -> HeldBm25Setting {
    let settings = match settings {
        Some(Value::Object(settings)) => Some(settings),
        _ => None,
    };
    let bm25 = settings
        .and_then(|settings| settings.get("bm25"))
        .filter(|bm25| matches!(bm25, Value::Object(_)))
        .cloned();
    let revision = match settings.and_then(|settings| settings.get("bm25Revision")) {
        Some(Value::Number(revision))
            if revision.is_finite() && revision.fract() == 0.0 && *revision >= 0.0 =>
        {
            Some(*revision as u64)
        }
        _ => None,
    };
    HeldBm25Setting {
        index_uuid: record.index_uuid.clone(),
        bm25,
        revision,
    }
}

fn is_later_than(next: &HeldBm25Setting, held: &HeldBm25Setting) -> bool {
    next.revision.unwrap_or(0) > held.revision.unwrap_or(0)
}

fn hold(
    held: &Mutex<HashMap<String, HeldBm25Setting>>,
    index_name: &str,
    next: HeldBm25Setting,
) -> HeldBm25Setting {
    let mut held = lock(held);
    if let Some(current) = held.get(index_name)
        && current.index_uuid == next.index_uuid
        && !is_later_than(&next, current)
    {
        return current.clone();
    }
    held.insert(index_name.to_string(), next.clone());
    next
}

pub(crate) struct Bm25View {
    coordinator: Arc<EtcdCoordinator>,
    on_error: Option<NodeErrorHandler>,
    held: Arc<Mutex<HashMap<String, HeldBm25Setting>>>,
    watch: Mutex<Option<WatchHandle>>,
}

impl Bm25View {
    pub(crate) fn new(
        coordinator: Arc<EtcdCoordinator>,
        on_error: Option<NodeErrorHandler>,
    ) -> Bm25View {
        Bm25View {
            coordinator,
            on_error,
            held: Arc::new(Mutex::new(HashMap::new())),
            watch: Mutex::new(None),
        }
    }

    pub(crate) fn held(&self, index_name: &str) -> Option<HeldBm25Setting> {
        lock(&self.held).get(index_name).cloned()
    }

    pub(crate) async fn current(&self, index_name: &str) -> ClusterResult<Option<HeldBm25Setting>> {
        if let Some(known) = self.held(index_name) {
            return Ok(Some(known));
        }
        let Some((record, settings)) = stored_index_metadata(&self.coordinator, index_name).await?
        else {
            return Ok(None);
        };
        let read = setting_of(&record, settings.as_ref());
        let mut held = lock(&self.held);
        match held.get(index_name) {
            Some(racing)
                if racing.index_uuid != read.index_uuid || !is_later_than(&read, racing) =>
            {
                Ok(Some(racing.clone()))
            }
            _ => {
                held.insert(index_name.to_string(), read.clone());
                Ok(Some(read))
            }
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
                        hold(
                            &held,
                            &event.index_name,
                            setting_of(&record, settings.as_ref()),
                        );
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
            if let Err(error) = self.current(&index_name).await {
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
