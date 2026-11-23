use std::collections::BTreeMap;
use std::future::Future;
use std::sync::{Arc, Weak};

use narsil::suggestions_host::{
    BuildRecord, HistoryFiles, HistoryFilesRef, IndexView, RemoteFile, SuggestionState,
    SuggestionsHost, suggestions_index_config,
};
use narsil::{
    AnalysisChange, BatchFailure, BatchResult, ErrorCode, ListParams, ListResult, Map, NarsilError,
    NarsilEvent, PreflightResult, QueryParams, QuerySuggestionsSource, Result, Value,
};

use super::super::handle::ClusterNode;
use super::super::member::NodeInner;
use super::build_records::{read_cluster_build_record, write_cluster_build_record};
use super::remote_history::{RemoteHistory, RemoteSource};
use super::view::ClusterSuggestionView;
use crate::constants::MAX_SETTINGS_REPLACEMENT_ATTEMPTS;
use crate::controller::{
    metadata_key, metadata_with_suggestion_state, read_index_metadata_snapshot,
};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::node::{CreateIndexOptions, WriteBatchResult};

const SETTINGS_CONTENTION_REASON: &str = "settings_contention";

pub(super) type ControllerCheck = Arc<dyn Fn() -> bool + Send + Sync>;

pub(super) fn narsil_error_of(error: ClusterError) -> NarsilError {
    let details: Vec<(String, Value)> = error
        .details()
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect();
    NarsilError::with_spec_code(error.code(), error.message()).with_details(details)
}

fn index_not_found(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::INDEX_NOT_FOUND,
        format!("Index '{index_name}' does not exist in the cluster"),
    )
    .with_details([("indexName", Value::from(index_name))])
}

fn batch_result_of(result: WriteBatchResult) -> BatchResult {
    BatchResult {
        succeeded: result.succeeded,
        failed: result
            .failed
            .into_iter()
            .map(|failure| BatchFailure {
                doc_id: failure.document_id,
                error: narsil_error_of(failure.error),
            })
            .collect(),
    }
}

pub(super) struct ClusterHost {
    pub(super) node_id: String,
    pub(super) node: Weak<NodeInner>,
    pub(super) files: Arc<HistoryFiles>,
    pub(super) view: Arc<ClusterSuggestionView>,
    pub(super) runtime: tokio::runtime::Handle,
    pub(super) is_controller: ControllerCheck,
}

impl ClusterHost {
    pub(super) fn run<T>(&self, work: impl Future<Output = ClusterResult<T>>) -> Result<T> {
        self.runtime.block_on(work).map_err(narsil_error_of)
    }

    fn remote_source(&self) -> RemoteSource {
        RemoteSource {
            node_id: self.node_id.clone(),
            node: Weak::clone(&self.node),
            files: Arc::clone(&self.files),
            runtime: self.runtime.clone(),
        }
    }

    fn cluster_node(&self) -> Result<ClusterNode> {
        match self.node.upgrade() {
            Some(inner) => Ok(ClusterNode { inner }),
            None => Err(NarsilError::with_spec_code(
                codes::NODE_NOT_READY,
                format!(
                    "Node '{}' has shut down, so it serves no popular query suggestions",
                    self.node_id
                ),
            )
            .with_details([("nodeId", Value::from(self.node_id.as_str()))])),
        }
    }

    async fn update_cluster_state(
        &self,
        node: &ClusterNode,
        index_name: &str,
        change: &mut dyn FnMut(&SuggestionState) -> Result<SuggestionState>,
    ) -> ClusterResult<SuggestionState> {
        let coordinator = node.inner.coordinator();
        for _ in 0..MAX_SETTINGS_REPLACEMENT_ATTEMPTS {
            let Some(current) = read_index_metadata_snapshot(coordinator, index_name).await? else {
                return Err(index_not_found(index_name).into());
            };
            self.view.refresh(index_name).await?;
            let settings = current.settings.clone().unwrap_or_default();
            let next = change(&SuggestionState::from_settings(&settings)?)?;
            let encoded = metadata_with_suggestion_state(&current, &next)?;
            if coordinator
                .compare_and_set(&metadata_key(index_name), Some(&current.bytes), &encoded)
                .await?
            {
                self.view.refresh(index_name).await?;
                return Ok(next);
            }
        }
        Err(ClusterError::new(
            codes::CLUSTER_WRITE_BLOCKED,
            format!(
                "Index '{index_name}' kept changing while its query suggestion settings were replaced {MAX_SETTINGS_REPLACEMENT_ATTEMPTS} times over, so nothing was stored. Retry the request"
            ),
        )
        .with_detail("reason", Value::from(SETTINGS_CONTENTION_REASON))
        .with_detail("indexName", Value::from(index_name))
        .with_detail("attempts", Value::from(MAX_SETTINGS_REPLACEMENT_ATTEMPTS)))
    }

    async fn create_marked_index(
        &self,
        node: &ClusterNode,
        name: &str,
        source: &QuerySuggestionsSource,
        language: &str,
    ) -> ClusterResult<()> {
        let Some(source_index) = self.view.get(&source.index) else {
            return Err(index_not_found(&source.index).into());
        };
        let options = CreateIndexOptions {
            partition_count: Some(1),
            replication_factor: Some(source_index.replication_factor),
            wait_for_serving_ms: None,
        };
        let config = suggestions_index_config(language);
        if let Err(error) = node
            .create_marked_index(name, config, options, source)
            .await
        {
            if error.code() != codes::INDEX_ALREADY_EXISTS {
                return Err(error);
            }
            let existing = self.view.refresh(name).await?;
            let marker = existing.as_ref().and_then(|index| index.state.source());
            if marker != Some(source) {
                return Err(error);
            }
            return Ok(());
        }
        self.view.refresh(name).await?;
        Ok(())
    }
}

impl SuggestionsHost for ClusterHost {
    fn node_id(&self) -> &str {
        &self.node_id
    }

    fn clustered(&self) -> bool {
        true
    }

    fn files(&self) -> HistoryFilesRef<'_> {
        self.files.files()
    }

    fn state(&self, index_name: &str) -> Option<Arc<SuggestionState>> {
        self.view
            .get(index_name)
            .map(|index| Arc::clone(&index.state))
    }

    fn require_state(&self, index_name: &str) -> Result<Arc<SuggestionState>> {
        self.state(index_name)
            .ok_or_else(|| index_not_found(index_name))
    }

    fn view(&self, index_name: &str) -> Option<IndexView> {
        self.view.get(index_name).map(|index| IndexView {
            state: Arc::clone(&index.state),
            schema: index.schema.clone(),
            language: index.language.clone(),
            index_uuid: Some(index.index_uuid.clone()),
            has_sync: index.has_sync,
        })
    }

    fn states(&self) -> BTreeMap<String, Arc<SuggestionState>> {
        self.view
            .names()
            .into_iter()
            .filter_map(|name| {
                let state = self.state(&name)?;
                Some((name, state))
            })
            .collect()
    }

    fn index_uuid(&self, index_name: &str) -> Option<String> {
        self.view
            .get(index_name)
            .map(|index| index.index_uuid.clone())
    }

    fn language(&self, index_name: &str) -> Result<String> {
        self.view
            .get(index_name)
            .map(|index| index.language.clone())
            .ok_or_else(|| index_not_found(index_name))
    }

    fn update_state(
        &self,
        index_name: &str,
        change: &mut dyn FnMut(&SuggestionState) -> Result<SuggestionState>,
    ) -> Result<SuggestionState> {
        let node = self.cluster_node()?;
        self.run(self.update_cluster_state(&node, index_name, change))
    }

    fn create_suggestions_index(
        &self,
        name: &str,
        source: &QuerySuggestionsSource,
        language: &str,
    ) -> Result<()> {
        let node = self.cluster_node()?;
        self.run(self.create_marked_index(&node, name, source, language))
    }

    fn remote_history(&self, index_name: &str) -> Box<dyn Iterator<Item = RemoteFile> + '_> {
        Box::new(RemoteHistory::new(self.remote_source(), index_name))
    }

    fn read_build_record(&self, index_name: &str) -> Option<BuildRecord> {
        let node = self.cluster_node().ok()?;
        self.run(read_cluster_build_record(
            node.inner.coordinator(),
            index_name,
        ))
        .ok()
        .flatten()
    }

    fn write_build_record(&self, index_name: &str, record: &BuildRecord) -> Result<()> {
        let node = self.cluster_node()?;
        self.run(write_cluster_build_record(
            node.inner.coordinator(),
            index_name,
            record,
        ))
    }

    fn may_build(&self) -> bool {
        (self.is_controller)()
    }

    fn emit(&self, _event: NarsilEvent) {}

    fn preflight(&self, index_name: &str, params: &QueryParams) -> Result<PreflightResult> {
        let node = self.cluster_node()?;
        self.run(node.preflight(index_name, params))
    }

    fn list_documents(&self, index_name: &str, params: &ListParams) -> Result<ListResult> {
        let node = self.cluster_node()?;
        self.run(node.list_documents(index_name, params))
    }

    fn insert_batch(&self, index_name: &str, documents: Vec<Map>) -> Result<BatchResult> {
        let node = self.cluster_node()?;
        self.run(node.insert_batch(index_name, documents))
            .map(batch_result_of)
    }

    fn update_batch(&self, index_name: &str, updates: Vec<(String, Map)>) -> Result<BatchResult> {
        let node = self.cluster_node()?;
        self.run(node.update_batch(index_name, updates))
            .map(batch_result_of)
    }

    fn remove_batch(&self, index_name: &str, ids: Vec<String>) -> Result<BatchResult> {
        let node = self.cluster_node()?;
        self.run(node.remove_batch(index_name, ids))
            .map(batch_result_of)
    }

    fn has(&self, index_name: &str, id: &str) -> Result<bool> {
        let node = self.cluster_node()?;
        self.run(node.has(index_name, id))
    }

    fn insert(&self, index_name: &str, document: Map) -> Result<()> {
        let node = self.cluster_node()?;
        self.run(node.insert(index_name, document, None))
            .map(|_| ())
    }

    fn update(&self, index_name: &str, id: &str, document: Map) -> Result<()> {
        let node = self.cluster_node()?;
        self.run(node.update(index_name, id, document))
    }

    fn change_analysis(&self, index_name: &str, change: &AnalysisChange) -> Result<()> {
        let node = self.cluster_node()?;
        self.run(node.change_analysis(index_name, change))
    }

    fn drop_index(&self, index_name: &str) -> Result<()> {
        let node = self.cluster_node()?;
        self.run(node.drop_index(index_name))
    }
}
