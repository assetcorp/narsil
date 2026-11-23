use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use super::build_record::BuildRecord;
use super::runtime::SuggestionsRuntime;
use super::stored_state::SuggestionState;
use super::types::{QuerySuggestionsSource, QuerySuggestionsWarningReason};
use crate::durability::checkpoint_store::CheckpointStore;
use crate::durability::platform::now_ms;
use crate::engine::EngineInner;
use crate::engine::changes::analysis::AnalysisChange;
use crate::engine::events::NarsilEvent;
use crate::engine::index::IndexState;
use crate::engine::index_lifecycle::HeldIndex;
use crate::engine::query::listing::{ListParams, ListResult};
use crate::engine::query::params::QueryParams;
use crate::engine::query::preflight::PreflightResult;
use crate::engine::sync::sync_is_on;
use crate::engine::writes::BatchResult;
use crate::error::{NarsilError, Result};
use crate::value::Map;

pub(crate) struct OpenIndexView<'a> {
    pub(crate) index: &'a IndexState,
    pub(crate) has_sync: bool,
}

/// The store that holds the query history files of a suggestions host.
pub struct HistoryFilesRef<'a> {
    store: &'a dyn CheckpointStore,
}

impl<'a> HistoryFilesRef<'a> {
    pub(crate) fn new(store: &'a dyn CheckpointStore) -> HistoryFilesRef<'a> {
        HistoryFilesRef { store }
    }

    pub(crate) fn store(&self) -> &'a dyn CheckpointStore {
        self.store
    }
}

/// What a suggestions host knows of one index: its suggestion state, its schema, its language, its UUID, and
/// whether it syncs to devices.
pub struct IndexView {
    /// The suggestion setting, ban list, and suggestions-index marker of the index.
    pub state: Arc<SuggestionState>,
    /// The schema definition of the index.
    pub schema: Map,
    /// The language that the index analyses its text in.
    pub language: String,
    /// The UUID of the index, where the host keeps one.
    pub index_uuid: Option<String>,
    /// Whether the index syncs to devices.
    pub has_sync: bool,
}

/// A query history file that a build reads from another node, or the mark of a node that sent none.
pub enum RemoteFile {
    /// A history file that node `node_id` keeps under `key`.
    File {
        /// The node that keeps the file.
        node_id: String,
        /// The key of the file in the history folder of the index.
        key: String,
        /// The bytes of the file.
        bytes: Vec<u8>,
    },
    /// A node that answered with no history, or with history that breaks the stream rules.
    Silent {
        /// The node that sent nothing that a build can merge.
        node_id: String,
    },
}

/// The engine that popular query suggestions count searches for, build suggestions indexes on, and keep their
/// settings in: the local engine of a single process, or a node of a cluster.
///
/// Every call blocks, so a host whose work is asynchronous runs it off its executor.
pub trait SuggestionsHost: Send + Sync {
    /// Returns the ID of the node that counts searches, which is empty for a single engine.
    fn node_id(&self) -> &str;

    /// Reports whether the host is a node of a cluster, whose history files carry the UUID of their index.
    fn clustered(&self) -> bool;

    /// Returns the store of the host's query history files.
    fn files(&self) -> HistoryFilesRef<'_>;

    /// Returns the suggestion state of `index_name` without opening a closed index, or `None` for a missing one.
    fn state(&self, index_name: &str) -> Option<Arc<SuggestionState>>;

    /// Returns the suggestion state of `index_name` for a call that needs the index, opening a closed one.
    ///
    /// # Errors
    ///
    /// Fails with `INDEX_NOT_FOUND` for a missing index.
    fn require_state(&self, index_name: &str) -> Result<Arc<SuggestionState>>;

    /// Returns what the host knows of `index_name` for a call that changes its suggestions, or `None` for a missing
    /// index.
    fn view(&self, index_name: &str) -> Option<IndexView>;

    /// Returns the suggestion state of every index that the host holds, by name.
    fn states(&self) -> BTreeMap<String, Arc<SuggestionState>>;

    /// Returns the UUID of `index_name`, which a cluster node writes into each history file of the index.
    fn index_uuid(&self, index_name: &str) -> Option<String>;

    /// Returns the language that `index_name` analyses its text in.
    ///
    /// # Errors
    ///
    /// Fails with `INDEX_NOT_FOUND` for a missing index.
    fn language(&self, index_name: &str) -> Result<String>;

    /// Stores the suggestion state that `change` returns for `index_name`, and returns it.
    ///
    /// # Errors
    ///
    /// Fails with the error of `change`, with `INDEX_NOT_FOUND` for a missing index, and with the error of the store.
    fn update_state(
        &self,
        index_name: &str,
        change: &mut dyn FnMut(&SuggestionState) -> Result<SuggestionState>,
    ) -> Result<SuggestionState>;

    /// Creates the suggestions index `name` of `source`, analysed in `language`, with the marker of `source`.
    ///
    /// # Errors
    ///
    /// Fails with the error of the index creation.
    fn create_suggestions_index(
        &self,
        name: &str,
        source: &QuerySuggestionsSource,
        language: &str,
    ) -> Result<()>;

    /// Returns the history files of `index_name` that every other node keeps, node by node in code point order.
    fn remote_history(&self, index_name: &str) -> Box<dyn Iterator<Item = RemoteFile> + '_>;

    /// Returns the record of the last build of `index_name`, or `None` where the host holds none that it can read.
    fn read_build_record(&self, index_name: &str) -> Option<BuildRecord>;

    /// Stores `record` as the record of the last build of `index_name`.
    ///
    /// # Errors
    ///
    /// Fails with the error of the store.
    fn write_build_record(&self, index_name: &str, record: &BuildRecord) -> Result<()>;

    /// Reports whether the host starts the builds that a schedule calls for.
    fn may_build(&self) -> bool;

    /// Raises `event` to the host's listeners.
    fn emit(&self, event: NarsilEvent);

    /// Returns how many documents of `index_name` match `params`.
    ///
    /// # Errors
    ///
    /// Fails with the error of the query.
    fn preflight(&self, index_name: &str, params: &QueryParams) -> Result<PreflightResult>;

    /// Returns a page of the documents of `index_name`.
    ///
    /// # Errors
    ///
    /// Fails with the error of the listing.
    fn list_documents(&self, index_name: &str, params: &ListParams) -> Result<ListResult>;

    /// Inserts `documents` into `index_name`.
    ///
    /// # Errors
    ///
    /// Fails with the error of the batch as a whole; a document that fails alone is in the result.
    fn insert_batch(&self, index_name: &str, documents: Vec<Map>) -> Result<BatchResult>;

    /// Replaces each document of `updates` in `index_name`.
    ///
    /// # Errors
    ///
    /// Fails with the error of the batch as a whole; a document that fails alone is in the result.
    fn update_batch(&self, index_name: &str, updates: Vec<(String, Map)>) -> Result<BatchResult>;

    /// Removes each document of `ids` from `index_name`.
    ///
    /// # Errors
    ///
    /// Fails with the error of the batch as a whole; a document that fails alone is in the result.
    fn remove_batch(&self, index_name: &str, ids: Vec<String>) -> Result<BatchResult>;

    /// Reports whether `index_name` holds the document `id`.
    ///
    /// # Errors
    ///
    /// Fails with the error of the read.
    fn has(&self, index_name: &str, id: &str) -> Result<bool>;

    /// Inserts `document` into `index_name` under the ID that it carries.
    ///
    /// # Errors
    ///
    /// Fails with the error of the write.
    fn insert(&self, index_name: &str, document: Map) -> Result<()>;

    /// Replaces the document `id` of `index_name` with `document`.
    ///
    /// # Errors
    ///
    /// Fails with the error of the write.
    fn update(&self, index_name: &str, id: &str, document: Map) -> Result<()>;

    /// Changes the analysis of `index_name` as `change` says.
    ///
    /// # Errors
    ///
    /// Fails with the error of the change.
    fn change_analysis(&self, index_name: &str, change: &AnalysisChange) -> Result<()>;

    /// Drops `index_name`.
    ///
    /// # Errors
    ///
    /// Fails with the error of the drop.
    fn drop_index(&self, index_name: &str) -> Result<()>;
}

pub(crate) trait SuggestionsOwner: Send + Sync {
    fn runtime(&self) -> &SuggestionsRuntime;
    fn host(&self) -> &dyn SuggestionsHost;
}

pub(crate) fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn wall_ms() -> i64 {
    i64::try_from(now_ms()).unwrap_or(i64::MAX)
}

pub(crate) fn suggestion_state_of(
    engine: &EngineInner,
    name: &str,
) -> Option<Arc<SuggestionState>> {
    engine.held_index(name).map(|held| match held {
        HeldIndex::Open(index) => index.suggestion_state(),
        HeldIndex::Closed(closed) => closed.suggestions,
    })
}

pub(crate) fn suggestion_states(engine: &EngineInner) -> BTreeMap<String, Arc<SuggestionState>> {
    let (open, closed) = engine.held_indexes();
    closed
        .into_iter()
        .map(|listing| (listing.name, listing.closed.suggestions))
        .chain(
            open.iter()
                .map(|index| (index.name.clone(), index.suggestion_state())),
        )
        .collect()
}

pub(crate) fn update_state(
    engine: &EngineInner,
    index_name: &str,
    change: impl FnOnce(&OpenIndexView<'_>, &SuggestionState) -> Result<SuggestionState>,
) -> Result<SuggestionState> {
    let (_name, index) = engine.open_index_in_turn(index_name)?;
    let _writer = index.lock_writes()?;
    let metadata = index.log().map(|log| log.metadata(&index));
    let view = OpenIndexView {
        index: &index,
        has_sync: metadata.as_ref().is_some_and(sync_is_on),
    };
    let next = change(&view, &index.suggestion_state())?;
    if let (Some(log), Some(mut metadata)) = (index.log(), metadata) {
        next.write_metadata(&mut metadata);
        log.write_recorded(metadata)?;
    }
    let _bans = locked(&engine.suggestions.ban_publication);
    index.replace_suggestion_state(next.clone());
    Ok(next)
}

pub(crate) fn warn(
    host: &dyn SuggestionsHost,
    index_name: &str,
    reason: QuerySuggestionsWarningReason,
    file: Option<String>,
    message: Option<String>,
) {
    host.emit(NarsilEvent::QuerySuggestionsWarning {
        index_name: index_name.to_string(),
        reason,
        file,
        message,
    });
}

pub(crate) fn warn_of_failure(
    host: &dyn SuggestionsHost,
    index_name: &str,
    reason: QuerySuggestionsWarningReason,
    error: &NarsilError,
) {
    let message = Some(error.message().to_string());
    warn(host, index_name, reason, None, message);
}
