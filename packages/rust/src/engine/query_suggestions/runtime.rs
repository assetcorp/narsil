use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::build_runner::BuildRunner;
use super::day_store::{CountRequest, DayContext, DayStore};
use super::history_files::{remove_history_folder, remove_restore_leftovers};
use super::host::{SuggestionsHost, SuggestionsOwner, locked, wall_ms, warn};
use super::phrase::{accepted_phrase, is_group, is_person};
use super::scramble::Scrambler;
use super::setting::ResolvedSetting;
use super::timers::{Timers, sweep_now};
use super::types::{
    QuerySuggestionsWarningReason, RecordQueryOutcome, RecordQueryResult, RecordedQuery,
};
use crate::durability::checkpoint_store::{AdapterStore, CheckpointStore};
use crate::durability::persistence::MemoryPersistence;
use crate::engine::name_turns::NameTurns;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::metadata_parts::config_invalid;

pub(crate) struct SuggestionsRuntime {
    scrambler: Option<Scrambler>,
    memory_files: AdapterStore,
    pub(crate) days: DayStore,
    pub(crate) builds: BuildRunner,
    pub(crate) timers: Timers,
    pub(crate) write_turns: NameTurns,
    stopping: AtomicBool,
    stop_turn: Mutex<()>,
    pub(crate) ban_publication: Mutex<()>,
}

fn not_enabled(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::QUERY_SUGGESTIONS_NOT_ENABLED,
        format!("Index \"{index_name}\" has popular query suggestions off"),
    )
    .with_details([("indexName", crate::value::Value::from(index_name))])
}

fn result_of(outcome: RecordQueryOutcome) -> RecordQueryResult {
    RecordQueryResult {
        recorded: outcome == RecordQueryOutcome::Recorded,
        outcome,
    }
}

impl SuggestionsRuntime {
    pub(crate) fn new(scrambler: Option<Scrambler>) -> SuggestionsRuntime {
        SuggestionsRuntime {
            scrambler,
            memory_files: AdapterStore::new(Arc::new(MemoryPersistence::new())),
            days: DayStore::default(),
            builds: BuildRunner::default(),
            timers: Timers::default(),
            write_turns: NameTurns::default(),
            stopping: AtomicBool::new(false),
            stop_turn: Mutex::new(()),
            ban_publication: Mutex::new(()),
        }
    }

    pub(crate) fn memory_files(&self) -> &dyn CheckpointStore {
        &self.memory_files
    }

    pub(crate) fn scrambler(&self) -> Option<&Scrambler> {
        self.scrambler.as_ref()
    }

    pub(crate) fn require_scrambler(&self) -> Result<&Scrambler> {
        self.scrambler.as_ref().ok_or_else(|| {
            config_invalid("This engine has no query suggestions key, so it holds no counts")
        })
    }

    pub(crate) fn guard_stopping(&self) -> Result<()> {
        if self.stopping.load(Ordering::SeqCst) {
            return Err(NarsilError::new(
                ErrorCode::INSTANCE_SHUT_DOWN,
                "The engine is shutting down",
            ));
        }
        Ok(())
    }

    pub(crate) fn enabled_setting(
        &self,
        host: &dyn SuggestionsHost,
        index_name: &str,
    ) -> Result<ResolvedSetting> {
        match host.require_state(index_name)?.setting.as_ref() {
            Some(setting) if setting.enabled => Ok(setting.resolve()),
            _ => Err(not_enabled(index_name)),
        }
    }

    fn context<'a>(&'a self, host: &'a dyn SuggestionsHost) -> Option<DayContext<'a>> {
        Some(DayContext {
            host,
            files: host.files().store(),
            scrambler: self.scrambler.as_ref()?,
        })
    }

    pub(crate) fn save_day(&self, host: &dyn SuggestionsHost, index_name: &str) {
        if let Some(context) = self.context(host) {
            self.days.save(&context, index_name);
        }
    }

    pub(crate) fn retire_days(&self, host: &dyn SuggestionsHost, today: &str) {
        if let Some(context) = self.context(host) {
            for index_name in self.days.indexes() {
                self.days.retire(&context, &index_name, today);
            }
        }
    }

    pub(crate) fn record(
        &self,
        host: &dyn SuggestionsHost,
        index_name: &str,
        query: &RecordedQuery,
    ) -> Result<RecordQueryResult> {
        self.guard_stopping()?;
        let setting = self.enabled_setting(host, index_name)?;
        let Some(context) = self.context(host) else {
            return Ok(result_of(RecordQueryOutcome::NoKey));
        };
        if !is_person(&query.person) || !is_group(&query.group) {
            return Ok(result_of(RecordQueryOutcome::Invalid));
        }
        let Some(phrase) = accepted_phrase(&query.query, &setting.phrase_limits()) else {
            return Ok(result_of(RecordQueryOutcome::Invalid));
        };
        let request = CountRequest {
            group: &query.group,
            phrase: &phrase,
            person: &query.person,
        };
        let outcome = self
            .days
            .count(&context, index_name, &setting, wall_ms(), &request)?
            .ok_or_else(|| not_enabled(index_name))?;
        if outcome == RecordQueryOutcome::Recorded {
            let interval = Duration::from_millis(u64::from(setting.save_interval_ms));
            self.timers.save_soon(index_name, interval);
        }
        Ok(result_of(outcome))
    }

    pub(crate) fn discard_history(
        &self,
        host: &dyn SuggestionsHost,
        index_name: &str,
    ) -> Result<()> {
        self.timers.forget_save(index_name);
        self.days.discard(index_name);
        remove_history_folder(host.files().store(), index_name)
    }

    pub(crate) fn on_drop(&self, host: &dyn SuggestionsHost, index_name: &str) {
        self.timers.forget_index(index_name);
        self.builds.forget(index_name);
        self.days.discard(index_name);
        let _ = remove_history_folder(host.files().store(), index_name);
    }

    pub(crate) fn start(&self, owner: &Arc<dyn SuggestionsOwner>) {
        let host = owner.host();
        if self.scrambler.is_some() {
            let _ = remove_restore_leftovers(host.files().store());
            sweep_now(host);
            self.timers.start(owner);
            return;
        }
        let states = host.states();
        let mut enabled = states
            .iter()
            .filter(|(_, state)| state.enabled())
            .peekable();
        if enabled.peek().is_none() {
            return;
        }
        for (index_name, _) in enabled {
            let reason = QuerySuggestionsWarningReason::NoKey;
            warn(host, index_name, reason, None, None);
        }
        sweep_now(host);
    }

    pub(crate) fn stop(&self, host: &dyn SuggestionsHost) {
        let _turn = locked(&self.stop_turn);
        if self.stopping.swap(true, Ordering::SeqCst) {
            return;
        }
        self.timers.stop();
        self.builds.settle();
        if let Some(context) = self.context(host) {
            for index_name in self.days.indexes() {
                self.days.save(&context, &index_name);
            }
        }
    }
}
