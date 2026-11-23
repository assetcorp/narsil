use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use narsil::replication::{CopyEpochStates, PartitionCopies};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::state::epoch_states_of_settings;
use crate::constants::{DEVICE_SYNC_RECONCILE_INTERVAL_MS, HIDDEN_GENERATION_PREFIX};
use crate::controller::{lock, stored_index_metadata};
use crate::coordinator::etcd::{EtcdCoordinator, WatchHandle};
use crate::data::blocking::off_executor;
use crate::data::copies::LocalCopies;
use crate::error::{ClusterError, ClusterResult};
use crate::node::{NodeErrorHandler, report_failure};

#[derive(Clone)]
struct HeldSyncIndex {
    serving_name: String,
    states: CopyEpochStates,
}

struct Reconciler {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

pub(crate) struct DeviceSyncView {
    coordinator: Arc<EtcdCoordinator>,
    copies: Arc<LocalCopies>,
    on_error: Option<NodeErrorHandler>,
    held: Mutex<HashMap<String, HeldSyncIndex>>,
    turn: tokio::sync::Mutex<()>,
    watches: Mutex<Vec<WatchHandle>>,
    reconciler: Mutex<Option<Reconciler>>,
    stopped: watch::Sender<bool>,
}

fn is_hidden_generation(index_name: &str) -> bool {
    index_name.starts_with(HIDDEN_GENERATION_PREFIX)
}

async fn read_held(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<Option<HeldSyncIndex>> {
    let Some((_, settings)) = stored_index_metadata(coordinator, index_name).await? else {
        return Ok(None);
    };
    let serving_name = coordinator
        .allocation(index_name)
        .await?
        .and_then(|table| table.generation)
        .unwrap_or_else(|| index_name.to_string());
    if stored_index_metadata(coordinator, &serving_name)
        .await?
        .is_none()
    {
        return Ok(None);
    }
    Ok(Some(HeldSyncIndex {
        serving_name,
        states: epoch_states_of_settings(settings.as_ref()),
    }))
}

impl DeviceSyncView {
    pub(crate) fn new(
        coordinator: Arc<EtcdCoordinator>,
        copies: Arc<LocalCopies>,
        on_error: Option<NodeErrorHandler>,
    ) -> DeviceSyncView {
        DeviceSyncView {
            coordinator,
            copies,
            on_error,
            held: Mutex::new(HashMap::new()),
            turn: tokio::sync::Mutex::new(()),
            watches: Mutex::new(Vec::new()),
            reconciler: Mutex::new(None),
            stopped: watch::Sender::new(true),
        }
    }

    fn is_stopped(&self) -> bool {
        *self.stopped.borrow()
    }

    fn report(&self, error: &ClusterError) {
        if !self.is_stopped() {
            report_failure(self.on_error.as_ref(), error);
        }
    }

    async fn adopt_on_local_copies(
        &self,
        index_name: &str,
        next: Option<&HeldSyncIndex>,
    ) -> ClusterResult<()> {
        let states = next.map(|held| held.states.clone()).unwrap_or_default();
        let serving_name = next.map_or(index_name, |held| held.serving_name.as_str());
        let copies = Arc::clone(&self.copies);
        let (name, serving) = (index_name.to_string(), serving_name.to_string());
        off_executor(move || -> ClusterResult<()> {
            let local: HashSet<String> = copies.index_names().into_iter().collect();
            let engine = PartitionCopies::new(&copies.engine);
            if local.contains(&serving) {
                engine.adopt_epoch_states(&serving, &states)?;
            }
            if serving != name && local.contains(&name) {
                engine.adopt_epoch_states(&name, &CopyEpochStates::default())?;
            }
            Ok(())
        })
        .await?
    }

    pub(crate) async fn refresh(&self, index_name: &str) -> ClusterResult<()> {
        let _turn = self.turn.lock().await;
        if self.is_stopped() {
            return Ok(());
        }
        let next = read_held(&self.coordinator, index_name).await?;
        match &next {
            Some(held) => lock(&self.held).insert(index_name.to_string(), held.clone()),
            None => lock(&self.held).remove(index_name),
        };
        self.adopt_on_local_copies(index_name, next.as_ref()).await
    }

    fn names_served_by(&self, changed_name: &str) -> Vec<String> {
        if !is_hidden_generation(changed_name) {
            return vec![changed_name.to_string()];
        }
        lock(&self.held)
            .iter()
            .filter(|(_, held)| held.serving_name == changed_name)
            .map(|(index_name, _)| index_name.clone())
            .collect()
    }

    fn on_metadata_change(self: &Arc<Self>, changed_name: &str) {
        for index_name in self.names_served_by(changed_name) {
            let view = Arc::clone(self);
            tokio::spawn(async move {
                if let Err(error) = view.refresh(&index_name).await {
                    view.report(&error);
                }
            });
        }
    }

    async fn names_of_served_generations(&self) -> ClusterResult<()> {
        let copies = Arc::clone(&self.copies);
        let local = off_executor(move || copies.index_names()).await?;
        let mut wanted: HashSet<String> = local
            .into_iter()
            .filter(|name| is_hidden_generation(name) && self.names_served_by(name).is_empty())
            .collect();
        if wanted.is_empty() {
            return Ok(());
        }
        for index_name in self.coordinator.list_schemas().await? {
            if self.is_stopped() || wanted.is_empty() {
                return Ok(());
            }
            if is_hidden_generation(&index_name) || lock(&self.held).contains_key(&index_name) {
                continue;
            }
            let generation = self
                .coordinator
                .allocation(&index_name)
                .await?
                .and_then(|table| table.generation);
            let Some(generation) = generation.filter(|generation| wanted.contains(generation))
            else {
                continue;
            };
            wanted.remove(&generation);
            if let Err(error) = self.refresh(&index_name).await {
                self.report(&error);
            }
        }
        Ok(())
    }

    async fn reconcile(&self) {
        let copies = Arc::clone(&self.copies);
        let Ok(local) = off_executor(move || copies.index_names()).await else {
            return;
        };
        for index_name in local {
            if self.is_stopped() {
                return;
            }
            if is_hidden_generation(&index_name) {
                continue;
            }
            let known = lock(&self.held).get(&index_name).cloned();
            let outcome = match known {
                None => self.refresh(&index_name).await,
                Some(known) => self.adopt_on_local_copies(&index_name, Some(&known)).await,
            };
            if let Err(error) = outcome {
                self.report(&error);
            }
        }
        let served_elsewhere: Vec<(String, HeldSyncIndex)> = lock(&self.held)
            .iter()
            .filter(|(index_name, held)| held.serving_name != **index_name)
            .map(|(index_name, held)| (index_name.clone(), held.clone()))
            .collect();
        for (index_name, known) in served_elsewhere {
            if self.is_stopped() {
                return;
            }
            if let Err(error) = self.adopt_on_local_copies(&index_name, Some(&known)).await {
                self.report(&error);
            }
        }
    }

    pub(crate) async fn start(self: &Arc<Self>) -> ClusterResult<()> {
        if !self.is_stopped() {
            return Ok(());
        }
        self.stopped.send_replace(false);
        let view = Arc::downgrade(self);
        let metadata = self
            .coordinator
            .watch_index_metadata(move |event| {
                if let Some(view) = view.upgrade() {
                    view.on_metadata_change(&event.index_name);
                }
            })
            .await?;
        lock(&self.watches).push(metadata);
        let view = Arc::downgrade(self);
        let allocation = self
            .coordinator
            .watch_allocation(move |table| {
                if let Some(view) = view.upgrade() {
                    view.on_metadata_change(&table.index_name);
                }
            })
            .await?;
        lock(&self.watches).push(allocation);
        if let Err(error) = self.names_of_served_generations().await {
            self.report(&error);
        }
        self.reconcile().await;
        self.start_reconciler();
        Ok(())
    }

    fn start_reconciler(self: &Arc<Self>) {
        let (stop, mut stopped) = watch::channel(false);
        let view: Weak<DeviceSyncView> = Arc::downgrade(self);
        let task = tokio::spawn(async move {
            let mut ticks =
                tokio::time::interval(Duration::from_millis(DEVICE_SYNC_RECONCILE_INTERVAL_MS));
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticks.tick().await;
            loop {
                tokio::select! {
                    _ = ticks.tick() => {}
                    _ = stopped.wait_for(|stopped| *stopped) => return,
                }
                let Some(view) = view.upgrade() else {
                    return;
                };
                view.reconcile().await;
            }
        });
        if let Some(previous) = lock(&self.reconciler).replace(Reconciler { stop, task }) {
            previous.task.abort();
        }
    }

    pub(crate) async fn stop(&self) {
        self.stopped.send_replace(true);
        for handle in lock(&self.watches).drain(..) {
            handle.stop();
        }
        let reconciler = lock(&self.reconciler).take();
        if let Some(reconciler) = reconciler {
            let _ = reconciler.stop.send(true);
            let _ = reconciler.task.await;
        }
        let _turn = self.turn.lock().await;
        lock(&self.held).clear();
    }
}
