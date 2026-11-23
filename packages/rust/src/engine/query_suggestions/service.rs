use std::io::Read;
use std::sync::Arc;

use super::counts_file::counts_file_index_uuid;
use super::counts_stream::HistoryStream;
use super::host::{SuggestionsHost, SuggestionsOwner};
use super::host_operations;
use super::operations::GROUP_FORMAT;
use super::phrase::is_group;
use super::restored_history::RestoredHistory;
use super::runtime::SuggestionsRuntime;
use super::scramble::Scrambler;
use super::suggestions_writer::{suggestions_config, suggestions_index_name};
use super::timers::catch_up_missed_builds;
use super::types::{
    ManualQuerySuggestion, QuerySuggestionsBuild, QuerySuggestionsBuildTrigger,
    QuerySuggestionsConfig, QuerySuggestionsPreview, QuerySuggestionsSetting,
    QuerySuggestionsStatus, RecordQueryResult, RecordedQuery,
};
use crate::config::IndexConfig;
use crate::error::Result;
use crate::format::metadata_parts::config_invalid;

/// Returns the configuration of a suggestions index that analyses its phrases in `language`: the `query`, `count`,
/// and `origin` fields, no stop words, and one partition.
pub fn suggestions_index_config(language: &str) -> IndexConfig {
    suggestions_config(language)
}

struct ServiceInner {
    runtime: SuggestionsRuntime,
    host: Arc<dyn SuggestionsHost>,
}

impl SuggestionsOwner for ServiceInner {
    fn runtime(&self) -> &SuggestionsRuntime {
        &self.runtime
    }

    fn host(&self) -> &dyn SuggestionsHost {
        &*self.host
    }
}

/// The popular query suggestions of a host other than a single engine, such as a node of a cluster: it counts
/// searches into the host's history files, runs the host's builds and schedules, and answers each call that
/// [`crate::QuerySuggestions`] answers for a single engine.
///
/// Every call blocks, so an async caller runs it off its executor.
pub struct SuggestionsService {
    inner: Arc<ServiceInner>,
}

/// Writes the query history that a backup restores for one index, and moves it into the history folder of the
/// index once the restore completes.
pub struct RestoredHistoryWriter {
    history: RestoredHistory,
}

impl RestoredHistoryWriter {
    /// Stages the history file that `body` holds.
    ///
    /// # Errors
    ///
    /// Fails where `body` cannot be read or the staged file cannot be written.
    pub fn add(&mut self, body: &mut dyn Read) -> Result<()> {
        self.history.add(body)
    }

    /// Replaces the history of the index with the staged files.
    ///
    /// # Errors
    ///
    /// Fails where the history store refuses a write or a removal.
    pub fn commit(&mut self) -> Result<()> {
        self.history.commit()
    }
}

impl SuggestionsService {
    /// Returns the suggestions of `host`, which scramble each person with the key of `config` and count nothing
    /// without one.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` for a key shorter than 32 bytes.
    pub fn new(
        host: Arc<dyn SuggestionsHost>,
        config: Option<&QuerySuggestionsConfig>,
    ) -> Result<SuggestionsService> {
        let scrambler = config
            .map(|config| Scrambler::new(&config.key))
            .transpose()?;
        Ok(SuggestionsService {
            inner: Arc::new(ServiceInner {
                runtime: SuggestionsRuntime::new(scrambler),
                host,
            }),
        })
    }

    fn owner(&self) -> Arc<dyn SuggestionsOwner> {
        self.inner.clone()
    }

    fn parts(&self) -> (&SuggestionsRuntime, &dyn SuggestionsHost) {
        (&self.inner.runtime, &*self.inner.host)
    }

    /// Reports whether the suggestions hold a key, without which they count nothing and build nothing.
    pub fn has_key(&self) -> bool {
        self.inner.runtime.scrambler().is_some()
    }

    /// Warns of each index that has the feature on without a key, removes history past its retention, and starts
    /// the timers that save counts, run schedules, and start each build that a schedule missed.
    pub fn start(&self) {
        self.inner.runtime.start(&self.owner());
    }

    /// Stops the timers, waits for each build under way, and saves every count that the host holds.
    pub fn stop(&self) {
        let (runtime, host) = self.parts();
        runtime.stop(host);
    }

    /// Counts one search of `index_name`, as [`crate::QuerySuggestions::record_query`] does.
    ///
    /// # Errors
    ///
    /// Fails as [`crate::QuerySuggestions::record_query`] does.
    pub fn record_query(
        &self,
        index_name: &str,
        query: &RecordedQuery,
    ) -> Result<RecordQueryResult> {
        let (runtime, host) = self.parts();
        runtime.record(host, index_name, query)
    }

    /// Replaces the setting of `index_name`, as [`crate::QuerySuggestions::update_setting`] does.
    ///
    /// # Errors
    ///
    /// Fails as [`crate::QuerySuggestions::update_setting`] does, and with the error of the host's store.
    pub fn update_setting(
        &self,
        index_name: &str,
        setting: &QuerySuggestionsSetting,
    ) -> Result<()> {
        let (runtime, host) = self.parts();
        host_operations::update_setting(runtime, host, index_name, setting)
    }

    /// Returns the status of `index_name`, as [`crate::QuerySuggestions::status`] does.
    ///
    /// # Errors
    ///
    /// Fails with `INDEX_NOT_FOUND` for a missing index.
    pub fn status(&self, index_name: &str) -> Result<QuerySuggestionsStatus> {
        let (runtime, host) = self.parts();
        host_operations::status(runtime, host, index_name)
    }

    /// Runs a build of `index_name` on the calling thread, as [`crate::QuerySuggestions::build`] does.
    ///
    /// # Errors
    ///
    /// Fails as [`crate::QuerySuggestions::build`] does.
    pub fn build(&self, index_name: &str) -> Result<QuerySuggestionsBuild> {
        let (runtime, host) = self.parts();
        let trigger = QuerySuggestionsBuildTrigger::Caller;
        runtime.builds.start(runtime, host, index_name, trigger)
    }

    /// Starts a build of `index_name` for a caller on another node on a thread of its own, and returns once the
    /// host holds the record of the running build: the running build, or a skipped one where another build of the
    /// index is under way.
    ///
    /// # Errors
    ///
    /// Fails as [`crate::QuerySuggestions::build`] does before a build starts.
    pub fn begin_build(&self, index_name: &str) -> Result<QuerySuggestionsBuild> {
        let trigger = QuerySuggestionsBuildTrigger::Caller;
        let owner = self.owner();
        self.inner.runtime.builds.begin(&owner, index_name, trigger)
    }

    /// Returns what a build of `index_name` would publish now, as [`crate::QuerySuggestions::preview`] does.
    ///
    /// # Errors
    ///
    /// Fails as [`crate::QuerySuggestions::preview`] does.
    pub fn preview(&self, index_name: &str, limit: Option<u32>) -> Result<QuerySuggestionsPreview> {
        let (runtime, host) = self.parts();
        host_operations::preview(runtime, host, index_name, limit)
    }

    /// Returns the ban list of `index_name`.
    ///
    /// # Errors
    ///
    /// Fails with `INDEX_NOT_FOUND` for a missing index.
    pub fn bans(&self, index_name: &str) -> Result<Vec<String>> {
        host_operations::bans(&*self.inner.host, index_name)
    }

    /// Replaces the ban list of `index_name`, as [`crate::QuerySuggestions::update_bans`] does.
    ///
    /// # Errors
    ///
    /// Fails as [`crate::QuerySuggestions::update_bans`] does.
    pub fn update_bans(&self, index_name: &str, phrases: &[String]) -> Result<Vec<String>> {
        let (runtime, host) = self.parts();
        host_operations::update_bans(runtime, host, index_name, phrases)
    }

    /// Bans `query` for `index_name`, as [`crate::QuerySuggestions::remove_query`] does.
    ///
    /// # Errors
    ///
    /// Fails as [`crate::QuerySuggestions::remove_query`] does.
    pub fn remove_query(&self, index_name: &str, query: &str) -> Result<u64> {
        let (runtime, host) = self.parts();
        host_operations::remove_query(runtime, host, index_name, query)
    }

    /// Adds a suggestion by hand, as [`crate::QuerySuggestions::add_suggestion`] does.
    ///
    /// # Errors
    ///
    /// Fails as [`crate::QuerySuggestions::add_suggestion`] does.
    pub fn add_suggestion(
        &self,
        index_name: &str,
        suggestion: &ManualQuerySuggestion,
    ) -> Result<String> {
        let (runtime, host) = self.parts();
        host_operations::add_suggestion(runtime, host, index_name, suggestion)
    }

    /// Returns the name of the suggestions index of `group` for `index_name`, as
    /// [`crate::QuerySuggestions::suggestions_index_name`] does.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` for a group outside its format.
    pub fn suggestions_index_name(&self, index_name: &str, group: &str) -> Result<String> {
        if !is_group(group) {
            return Err(config_invalid(format!("A group holds {GROUP_FORMAT}")));
        }
        Ok(suggestions_index_name(index_name, group))
    }

    /// Reports whether `bytes` hold a history file of `index_name` as it stands now: any readable file for a host
    /// outside a cluster, and for a cluster node only a file that carries the present UUID of the index, so that a
    /// backup leaves out the files that an earlier index of the same name left behind.
    pub fn holds_history_of(&self, index_name: &str, bytes: &[u8]) -> bool {
        let host = &*self.inner.host;
        let Some(file_uuid) = counts_file_index_uuid(bytes) else {
            return !host.clustered();
        };
        !host.clustered() || host.index_uuid(index_name).as_deref() == Some(file_uuid.as_str())
    }

    /// Writes the unsaved counts of `index_name` to its history files.
    pub fn save_day(&self, index_name: &str) {
        let (runtime, host) = self.parts();
        runtime.save_day(host, index_name);
    }

    /// Deletes every count and history file of `index_name`.
    ///
    /// # Errors
    ///
    /// Fails where the history store refuses a removal.
    pub fn discard_history(&self, index_name: &str) -> Result<()> {
        let (runtime, host) = self.parts();
        runtime.discard_history(host, index_name)
    }

    /// Forgets `index_name` once it is gone: its timers, its last build, its counts, and its history files.
    pub fn forget_index(&self, index_name: &str) {
        let (runtime, host) = self.parts();
        runtime.on_drop(host, index_name);
    }

    /// Arms the schedule of `index_name` again after its setting changed.
    pub fn setting_changed(&self, index_name: &str) {
        let (runtime, host) = self.parts();
        runtime.timers.rearm(runtime, host, index_name);
    }

    /// Starts each build that a schedule called for since the last build that ended as planned.
    pub fn catch_up_missed_builds(&self) {
        catch_up_missed_builds(&self.owner());
    }

    /// Returns the counts stream of `index_name`, after the unsaved counts of the index reach its history files.
    ///
    /// # Errors
    ///
    /// Fails where the history store cannot list the history folder of the index.
    pub fn history_stream(&self, index_name: &str) -> Result<HistoryStream> {
        self.save_day(index_name);
        HistoryStream::open(self.owner(), index_name)
    }

    /// Returns a writer of the history that a backup restores for `index_name` under `setting`, or `None` where
    /// the setting has the feature off or the suggestions hold no key.
    ///
    /// # Errors
    ///
    /// Fails where the engine cannot draw a staging name.
    pub fn restored_history(
        &self,
        index_name: &str,
        setting: Option<&QuerySuggestionsSetting>,
    ) -> Result<Option<RestoredHistoryWriter>> {
        Ok(
            RestoredHistory::open_for(self.owner(), index_name, setting)?
                .map(|history| RestoredHistoryWriter { history }),
        )
    }
}
