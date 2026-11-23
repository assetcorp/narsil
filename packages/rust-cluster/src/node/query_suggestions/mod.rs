mod backup_history;
mod build_records;
mod build_request;
mod host;
mod marked_index;
mod messages;
mod provider;
mod remote_history;
mod view;

use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use narsil::QuerySuggestionsConfig;
use narsil::suggestions_host::{HistoryFiles, SuggestionState, SuggestionsService};
use tokio::task::JoinHandle;

use self::build_records::delete_cluster_build_record;
use self::host::{ClusterHost, ControllerCheck};
use self::view::{ClusterSuggestionView, SuggestionViewEvents};
use super::config::{NodeErrorHandler, report_failure};
use super::member::NodeInner;
use crate::backups::ClusterQueryHistory;
use crate::constants::CONTROLLER_LEASE_CHECK_INTERVAL_MS;
use crate::controller::{ControllerMessageHandler, lock};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::data::blocking::off_executor;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::TransportMessage;
use crate::transport::Respond;

pub use self::provider::ClusterQuerySuggestions;

type ServiceSlot = Arc<Mutex<Option<Arc<SuggestionsService>>>>;

struct ViewEvents {
    service: ServiceSlot,
    on_error: Option<NodeErrorHandler>,
}

impl ViewEvents {
    fn service(&self) -> Option<Arc<SuggestionsService>> {
        lock(&self.service).clone()
    }
}

impl SuggestionViewEvents for ViewEvents {
    fn on_gone(&self, index_name: &str) {
        let Some(service) = self.service() else {
            return;
        };
        let index_name = index_name.to_string();
        tokio::task::spawn_blocking(move || service.forget_index(&index_name));
    }

    fn on_setting_changed(
        &self,
        index_name: &str,
        previous: &SuggestionState,
        next: &SuggestionState,
    ) {
        let Some(service) = self.service() else {
            return;
        };
        let discard = previous.enabled() && !next.enabled();
        let index_name = index_name.to_string();
        let on_error = self.on_error.clone();
        tokio::task::spawn_blocking(move || {
            if discard && let Err(error) = service.discard_history(&index_name) {
                report_failure(on_error.as_ref(), &ClusterError::from(error));
            }
            service.setting_changed(&index_name);
        });
    }

    fn on_error(&self, error: &ClusterError) {
        report_failure(self.on_error.as_ref(), error);
    }
}

pub(super) struct NodeSuggestions {
    node_id: String,
    node: Weak<NodeInner>,
    this: Weak<NodeSuggestions>,
    coordinator: Arc<EtcdCoordinator>,
    config: Option<QuerySuggestionsConfig>,
    view: Arc<ClusterSuggestionView>,
    is_controller: ControllerCheck,
    service: ServiceSlot,
    files: Mutex<Option<Arc<HistoryFiles>>>,
    lease_task: Mutex<Option<JoinHandle<()>>>,
    on_error: Option<NodeErrorHandler>,
}

pub(super) struct NodeSuggestionsSettings {
    pub(super) node_id: String,
    pub(super) node: Weak<NodeInner>,
    pub(super) coordinator: Arc<EtcdCoordinator>,
    pub(super) config: Option<QuerySuggestionsConfig>,
    pub(super) is_controller: ControllerCheck,
    pub(super) on_error: Option<NodeErrorHandler>,
}

impl NodeSuggestions {
    pub(super) fn new(settings: NodeSuggestionsSettings) -> Arc<NodeSuggestions> {
        let NodeSuggestionsSettings {
            node_id,
            node,
            coordinator,
            config,
            is_controller,
            on_error,
        } = settings;
        let service: ServiceSlot = Arc::new(Mutex::new(None));
        let events = Arc::new(ViewEvents {
            service: Arc::clone(&service),
            on_error: on_error.clone(),
        });
        Arc::new_cyclic(|this| NodeSuggestions {
            node_id,
            node,
            this: Weak::clone(this),
            view: Arc::new(ClusterSuggestionView::new(Arc::clone(&coordinator), events)),
            coordinator,
            config,
            is_controller,
            service,
            files: Mutex::new(None),
            lease_task: Mutex::new(None),
            on_error,
        })
    }

    pub(super) fn query_history(self: &Arc<Self>) -> Arc<dyn ClusterQueryHistory> {
        Arc::clone(self) as Arc<dyn ClusterQueryHistory>
    }

    fn report(&self, error: &ClusterError) {
        report_failure(self.on_error.as_ref(), error);
    }

    fn service(&self) -> ClusterResult<Arc<SuggestionsService>> {
        lock(&self.service).clone().ok_or_else(|| {
            let node_id = self.node_id.as_str();
            ClusterError::new(
                codes::NODE_NOT_READY,
                format!(
                    "Node '{node_id}' has yet to start, so it serves no popular query suggestions"
                ),
            )
            .with_detail("nodeId", narsil::Value::from(node_id))
        })
    }

    pub(super) fn controller_messages(self: &Arc<Self>) -> ControllerMessageHandler {
        let suggestions = Arc::downgrade(self);
        Arc::new(move |message: TransportMessage, respond: Respond| {
            let suggestions = suggestions.upgrade();
            Box::pin(async move {
                if let Some(suggestions) = suggestions {
                    messages::answer_build(suggestions, message, respond).await;
                }
            })
        })
    }

    pub(super) async fn answer_counts(&self, message: TransportMessage, respond: Respond) {
        messages::answer_counts(self, message, respond).await;
    }

    async fn remove_orphan_folders(&self, files: &Arc<HistoryFiles>) -> ClusterResult<()> {
        let listed = Arc::clone(files);
        for name in off_executor(move || listed.index_names()).await?? {
            if self.view.get(&name).is_some() || self.view.refresh(&name).await?.is_some() {
                continue;
            }
            let removed = Arc::clone(files);
            off_executor(move || removed.remove_history_folder(&name)).await??;
        }
        Ok(())
    }

    pub(super) async fn start(self: &Arc<Self>, inner: &NodeInner) -> ClusterResult<()> {
        self.view.start().await?;
        let files = Arc::new(match &inner.data {
            Some(data) => data.history_files()?,
            None => HistoryFiles::in_memory(),
        });
        *lock(&self.files) = Some(Arc::clone(&files));
        if let Err(error) = self.remove_orphan_folders(&files).await {
            self.report(&error);
        }
        let host = ClusterHost {
            node_id: self.node_id.clone(),
            node: Weak::clone(&self.node),
            files,
            view: Arc::clone(&self.view),
            runtime: tokio::runtime::Handle::current(),
            is_controller: Arc::clone(&self.is_controller),
        };
        let service = Arc::new(SuggestionsService::new(
            Arc::new(host),
            self.config.as_ref(),
        )?);
        let started = Arc::clone(&service);
        off_executor(move || started.start()).await?;
        if let Some(previous) = lock(&self.service).replace(Arc::clone(&service)) {
            tokio::task::spawn_blocking(move || previous.stop());
        }
        let watcher = Arc::downgrade(self);
        let task = tokio::spawn(watch_controller_lease(watcher));
        if let Some(previous) = lock(&self.lease_task).replace(task) {
            previous.abort();
        }
        Ok(())
    }

    pub(super) async fn stop(&self) {
        if let Some(task) = lock(&self.lease_task).take() {
            task.abort();
        }
        let service = lock(&self.service).take();
        if let Some(service) = service
            && let Err(error) = off_executor(move || service.stop()).await
        {
            self.report(&error);
        }
        self.view.stop();
    }

    pub(super) async fn forget_index(&self, index_name: &str) -> ClusterResult<()> {
        delete_cluster_build_record(&self.coordinator, index_name).await?;
        let index_name = index_name.to_string();
        if let Ok(service) = self.service() {
            return off_executor(move || service.forget_index(&index_name)).await;
        }
        let Some(files) = lock(&self.files).clone() else {
            return Ok(());
        };
        off_executor(move || files.remove_history_folder(&index_name)).await??;
        Ok(())
    }
}

async fn watch_controller_lease(suggestions: Weak<NodeSuggestions>) {
    let mut was_controller = false;
    let mut interval =
        tokio::time::interval(Duration::from_millis(CONTROLLER_LEASE_CHECK_INTERVAL_MS));
    interval.tick().await;
    loop {
        interval.tick().await;
        let Some(suggestions) = suggestions.upgrade() else {
            return;
        };
        let is_controller = (suggestions.is_controller)();
        if is_controller
            && !was_controller
            && let Ok(service) = suggestions.service()
        {
            tokio::task::spawn_blocking(move || service.catch_up_missed_builds());
        }
        was_controller = is_controller;
    }
}
