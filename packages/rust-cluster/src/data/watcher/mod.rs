mod admission_wait;
mod bootstrap;
mod cleanup;
mod primary;
mod replica_sync;
mod report;
mod snapshot_stream;
mod state;
mod sync_frames;
mod table;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;

use self::state::{Action, WatcherState};
pub(super) use self::table::partition_of;
use self::table::{needs_seeding, process_table, seed_retained};
use super::blocking::off_executor;
use super::copies::LocalCopies;
use super::writes::{AllocationView, PrimaryWrites};
use crate::allocator::Table;
use crate::constants::DATA_ALLOCATION_DEBOUNCE_MS;
use crate::controller::{belongs_to_another_index, lock};
use crate::coordinator::etcd::{EtcdCoordinator, WatchHandle};
use crate::error::{ClusterError, ClusterResult};
use crate::node::{NodeErrorHandler, report_failure};
use crate::transport::NodeTransport;

pub(super) struct WatcherContext {
    node_id: String,
    coordinator: Arc<EtcdCoordinator>,
    transport: Arc<dyn NodeTransport>,
    copies: Arc<LocalCopies>,
    writes: Arc<PrimaryWrites>,
    on_error: Option<NodeErrorHandler>,
    state: Mutex<WatcherState>,
    arrived: Notify,
    stopping: watch::Sender<bool>,
}

pub(super) struct AllocationWatcher {
    context: Arc<WatcherContext>,
    watch: Option<WatchHandle>,
    loop_task: JoinHandle<()>,
}

impl WatcherContext {
    fn report(&self, error: &ClusterError) {
        if !*self.stopping.borrow() {
            report_failure(self.on_error.as_ref(), error);
        }
    }

    fn receive(&self, table: Table) {
        let mut state = lock(&self.state);
        if state.stopped {
            return;
        }
        state.arrivals.push(table);
        drop(state);
        self.arrived.notify_one();
    }

    async fn seed(self: &Arc<Self>, index_name: &str) {
        if !needs_seeding(&lock(&self.state), index_name) {
            return;
        }
        let (copies, name) = (Arc::clone(&self.copies), index_name.to_string());
        let held = match off_executor(move || copies.held_partition_ids(&name)).await {
            Ok(Ok(held)) => held,
            Ok(Err(error)) | Err(error) => {
                self.report(&error);
                Vec::new()
            }
        };
        seed_retained(&mut lock(&self.state), index_name, &held);
    }

    async fn process(self: &Arc<Self>, table: &Table, releases_torn_down: bool) {
        self.seed(&table.index_name).await;
        let mut actions = Vec::new();
        process_table(&mut lock(&self.state), &self.node_id, table, &mut actions);
        if releases_torn_down && table.assignments.is_empty() {
            actions.push(Action::ReleaseTornDown(table.index_name.clone()));
        }
        self.run_actions(actions).await;
    }

    async fn run_actions(self: &Arc<Self>, actions: Vec<Action>) {
        for action in actions {
            match action {
                Action::Bootstrap {
                    key,
                    primary_node_id,
                    primary_term,
                } => self.start_bootstrap(key, primary_node_id, primary_term),
                Action::HoldPartition(key) => self.hold_partition(key).await,
                Action::StartTerm { key, primary_term } => {
                    self.writes
                        .start_led_term(&key.0, key.1, primary_term as u64);
                }
                Action::RemovePartition(key) => self.remove_partition(key).await,
                Action::ReleaseTornDown(index_name) => self.release_torn_down(index_name).await,
            }
        }
    }

    fn take_superseded_pending(&self) -> Vec<Table> {
        let mut state = lock(&self.state);
        let arrivals = std::mem::take(&mut state.arrivals);
        let mut superseded = Vec::new();
        for table in arrivals {
            if let Some(pending) = state.pending.get(&table.index_name)
                && (table.version <= pending.version
                    || belongs_to_another_index(pending, table.index_uuid.as_deref()))
                && let Some(pending) = state.pending.remove(&table.index_name)
            {
                superseded.push(pending);
            }
            state.pending.insert(table.index_name.clone(), table);
        }
        superseded
    }

    async fn follow(self: Arc<Self>) {
        let mut stopping = self.stopping.subscribe();
        loop {
            tokio::select! {
                () = self.arrived.notified() => {}
                _ = stopping.wait_for(|stopped| *stopped) => return,
            }
            let settles_at =
                tokio::time::Instant::now() + Duration::from_millis(DATA_ALLOCATION_DEBOUNCE_MS);
            loop {
                for pending in self.take_superseded_pending() {
                    self.process(&pending, true).await;
                }
                tokio::select! {
                    () = self.arrived.notified() => continue,
                    () = tokio::time::sleep_until(settles_at) => break,
                    _ = stopping.wait_for(|stopped| *stopped) => return,
                }
            }
            for pending in self.take_superseded_pending() {
                self.process(&pending, true).await;
            }
            let ready: Vec<Table> = lock(&self.state)
                .pending
                .drain()
                .map(|(_, table)| table)
                .collect();
            for table in ready {
                self.process(&table, true).await;
            }
        }
    }

    async fn initial_tables(&self) -> ClusterResult<Vec<Table>> {
        let mut tables = Vec::new();
        for index_name in self.coordinator.list_schemas().await? {
            if let Some(table) = self.live_table(&index_name).await? {
                tables.push(table);
            }
        }
        Ok(tables)
    }
}

pub(super) struct WatcherSettings {
    pub(super) node_id: String,
    pub(super) coordinator: Arc<EtcdCoordinator>,
    pub(super) transport: Arc<dyn NodeTransport>,
    pub(super) copies: Arc<LocalCopies>,
    pub(super) view: Arc<AllocationView>,
    pub(super) writes: Arc<PrimaryWrites>,
    pub(super) on_error: Option<NodeErrorHandler>,
}

impl AllocationWatcher {
    pub(super) async fn start(settings: WatcherSettings) -> ClusterResult<AllocationWatcher> {
        let context = Arc::new(WatcherContext {
            node_id: settings.node_id,
            coordinator: settings.coordinator,
            transport: settings.transport,
            copies: settings.copies,
            writes: settings.writes,
            on_error: settings.on_error,
            state: Mutex::new(WatcherState::default()),
            arrived: Notify::new(),
            stopping: watch::Sender::new(false),
        });
        let receiver = Arc::downgrade(&context);
        let view = settings.view;
        let watch = context
            .coordinator
            .watch_allocation(move |stored| {
                let table = Table::from_stored(&stored);
                view.observe(&table);
                if let Some(context) = receiver.upgrade() {
                    context.receive(table);
                }
            })
            .await?;
        let tables = match context.initial_tables().await {
            Ok(tables) => tables,
            Err(error) => {
                watch.stop();
                return Err(error);
            }
        };
        for table in &tables {
            context.process(table, false).await;
        }
        let loop_task = tokio::spawn(Arc::clone(&context).follow());
        Ok(AllocationWatcher {
            context,
            watch: Some(watch),
            loop_task,
        })
    }

    pub(super) fn unserved_partition_count(&self) -> usize {
        lock(&self.context.state).unserved.len()
    }

    pub(super) async fn stop(mut self) {
        if let Some(watch) = self.watch.take() {
            watch.stop();
        }
        self.context.stopping.send_replace(true);
        let tasks: Vec<JoinHandle<()>> = {
            let mut state = lock(&self.context.state);
            state.stopped = true;
            state.unserved.clear();
            state.pending.clear();
            state.arrivals.clear();
            state.awaited.clear();
            state
                .bootstraps
                .drain()
                .filter_map(|(_, mut slot)| {
                    slot.abort();
                    slot.task.take()
                })
                .collect()
        };
        let _ = (&mut self.loop_task).await;
        for task in tasks {
            let _ = task.await;
        }
    }
}
