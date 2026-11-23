use std::collections::BTreeMap;
use std::sync::Arc;

use super::build_record::{BuildRecord, decode_build_record, encode_build_record};
use super::history_files::{HistoryRead, build_record_key, read_history_file};
use super::host::{
    HistoryFilesRef, IndexView, RemoteFile, SuggestionsHost, SuggestionsOwner, suggestion_state_of,
    suggestion_states, update_state,
};
use super::runtime::SuggestionsRuntime;
use super::stored_state::SuggestionState;
use super::suggestions_writer::suggestions_config;
use super::types::QuerySuggestionsSource;
use crate::engine::changes::analysis::AnalysisChange;
use crate::engine::events::NarsilEvent;
use crate::engine::query::listing::{ListParams, ListResult};
use crate::engine::query::params::QueryParams;
use crate::engine::query::preflight::PreflightResult;
use crate::engine::sync::sync_is_on;
use crate::engine::writes::BatchResult;
use crate::engine::{EngineInner, Narsil, lifecycle};
use crate::error::{Result, instance_shut_down};
use crate::value::Map;

const SINGLE_ENGINE_NODE_ID: &str = "";

impl EngineInner {
    fn narsil(&self) -> Result<Narsil> {
        self.self_ref
            .upgrade()
            .map(|inner| Narsil { inner })
            .ok_or_else(instance_shut_down)
    }
}

impl SuggestionsOwner for EngineInner {
    fn runtime(&self) -> &SuggestionsRuntime {
        &self.suggestions
    }

    fn host(&self) -> &dyn SuggestionsHost {
        self
    }
}

impl SuggestionsHost for EngineInner {
    fn node_id(&self) -> &str {
        SINGLE_ENGINE_NODE_ID
    }

    fn clustered(&self) -> bool {
        false
    }

    fn files(&self) -> HistoryFilesRef<'_> {
        HistoryFilesRef::new(match &self.durable {
            Some(durable) => durable.files(),
            None => self.suggestions.memory_files(),
        })
    }

    fn state(&self, index_name: &str) -> Option<Arc<SuggestionState>> {
        suggestion_state_of(self, index_name)
    }

    fn require_state(&self, index_name: &str) -> Result<Arc<SuggestionState>> {
        Ok(self.reach_index(index_name)?.suggestion_state())
    }

    fn view(&self, index_name: &str) -> Option<IndexView> {
        let index = self.reach_index(index_name).ok()?;
        let has_sync = index
            .log()
            .is_some_and(|log| sync_is_on(&log.metadata(&index)));
        Some(IndexView {
            state: index.suggestion_state(),
            schema: index.schema.definition.clone(),
            language: index.analyser().language().name().to_string(),
            index_uuid: None,
            has_sync,
        })
    }

    fn states(&self) -> BTreeMap<String, Arc<SuggestionState>> {
        suggestion_states(self)
    }

    fn index_uuid(&self, _index_name: &str) -> Option<String> {
        None
    }

    fn language(&self, index_name: &str) -> Result<String> {
        let index = self.reach_index(index_name)?;
        Ok(index.analyser().language().name().to_string())
    }

    fn update_state(
        &self,
        index_name: &str,
        change: &mut dyn FnMut(&SuggestionState) -> Result<SuggestionState>,
    ) -> Result<SuggestionState> {
        update_state(self, index_name, |_, current| change(current))
    }

    fn create_suggestions_index(
        &self,
        name: &str,
        source: &QuerySuggestionsSource,
        language: &str,
    ) -> Result<()> {
        let state = SuggestionState {
            source: Some(source.clone()),
            ..SuggestionState::default()
        };
        lifecycle::create_marked_index(self, name, suggestions_config(language), state)
    }

    fn remote_history(&self, _index_name: &str) -> Box<dyn Iterator<Item = RemoteFile> + '_> {
        Box::new(std::iter::empty())
    }

    fn read_build_record(&self, index_name: &str) -> Option<BuildRecord> {
        match read_history_file(self.files().store(), &build_record_key(index_name)) {
            Ok(HistoryRead::Bytes(bytes)) => decode_build_record(&bytes),
            _ => None,
        }
    }

    fn write_build_record(&self, index_name: &str, record: &BuildRecord) -> Result<()> {
        let bytes = encode_build_record(record)?;
        self.files()
            .store()
            .write_commit(&build_record_key(index_name), &bytes)
    }

    fn may_build(&self) -> bool {
        true
    }

    fn emit(&self, event: NarsilEvent) {
        self.events.emit(event);
    }

    fn preflight(&self, index_name: &str, params: &QueryParams) -> Result<PreflightResult> {
        self.narsil()?.preflight(index_name, params)
    }

    fn list_documents(&self, index_name: &str, params: &ListParams) -> Result<ListResult> {
        self.narsil()?.list_documents(index_name, params)
    }

    fn insert_batch(&self, index_name: &str, documents: Vec<Map>) -> Result<BatchResult> {
        self.narsil()?.insert_batch(index_name, documents)
    }

    fn update_batch(&self, index_name: &str, updates: Vec<(String, Map)>) -> Result<BatchResult> {
        self.narsil()?.update_batch(index_name, updates)
    }

    fn remove_batch(&self, index_name: &str, ids: Vec<String>) -> Result<BatchResult> {
        self.narsil()?.remove_batch(index_name, ids)
    }

    fn has(&self, index_name: &str, id: &str) -> Result<bool> {
        self.narsil()?.has(index_name, id)
    }

    fn insert(&self, index_name: &str, document: Map) -> Result<()> {
        self.narsil()?
            .insert(index_name, document, None)
            .map(|_| ())
    }

    fn update(&self, index_name: &str, id: &str, document: Map) -> Result<()> {
        self.narsil()?.update(index_name, id, document)
    }

    fn change_analysis(&self, index_name: &str, change: &AnalysisChange) -> Result<()> {
        self.narsil()?.change_analysis(index_name, change)
    }

    fn drop_index(&self, index_name: &str) -> Result<()> {
        self.narsil()?.drop_index(index_name)
    }
}
