use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::day_counts::CountOutcome;
use super::days::{CountRequest, Counted, DayContext, DayStore};
use super::history::{remove_history_folder, remove_restore_leftovers};
use super::known::suggestion_states;
use super::phrase::{accepted_phrase, is_group, is_person};
use super::runner::BuildRunner;
use super::scramble::Scrambler;
use super::setting::ResolvedSetting;
use super::timers::{Timers, sweep_now};
use super::types::{
    QuerySuggestionsWarningReason, RecordQueryOutcome, RecordQueryResult, RecordedQuery,
};
use super::warnings::warn;
use crate::durability::checkpoint_store::{AdapterStore, CheckpointStore};
use crate::durability::persistence::MemoryPersistence;
use crate::durability::platform::now_ms;
use crate::engine::EngineInner;
use crate::engine::name_turns::NameTurns;
use crate::error::{ErrorCode, NarsilError, Result};

/// The popular query suggestions of one engine: its key, the counts that it holds, its builds, and its timers.
pub(crate) struct SuggestionsRuntime {
    scrambler: Option<Scrambler>,
    memory_files: AdapterStore,
    pub(crate) days: DayStore,
    pub(crate) builds: BuildRunner,
    pub(crate) timers: Timers,
    pub(crate) write_turns: NameTurns,
    stopping: Mutex<bool>,
    stop_wake: Condvar,
    stop_turn: Mutex<()>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn not_enabled(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::QUERY_SUGGESTIONS_NOT_ENABLED,
        format!("Index \"{index_name}\" has popular query suggestions off"),
    )
}

fn shutting_down() -> NarsilError {
    NarsilError::new(ErrorCode::INSTANCE_SHUT_DOWN, "The engine is shutting down")
}

fn wall_ms() -> i64 {
    i64::try_from(now_ms()).unwrap_or(i64::MAX)
}

fn outcome_of(counted: CountOutcome) -> RecordQueryOutcome {
    match counted {
        CountOutcome::Recorded => RecordQueryOutcome::Recorded,
        CountOutcome::Repeat => RecordQueryOutcome::Repeat,
        CountOutcome::PersonLimit => RecordQueryOutcome::PersonLimit,
        CountOutcome::PhraseLimit => RecordQueryOutcome::PhraseLimit,
        CountOutcome::PeopleLimit => RecordQueryOutcome::PeopleLimit,
        CountOutcome::GroupLimit => RecordQueryOutcome::GroupLimit,
    }
}

fn result_of(outcome: RecordQueryOutcome) -> RecordQueryResult {
    RecordQueryResult {
        recorded: outcome == RecordQueryOutcome::Recorded,
        outcome,
    }
}

impl SuggestionsRuntime {
    /// Returns the runtime of an engine that scrambles each person with `scrambler`, or that counts nothing
    /// without one.
    pub(crate) fn new(scrambler: Option<Scrambler>) -> SuggestionsRuntime {
        SuggestionsRuntime {
            scrambler,
            memory_files: AdapterStore::new(Arc::new(MemoryPersistence::new())),
            days: DayStore::default(),
            builds: BuildRunner::default(),
            timers: Timers::default(),
            write_turns: NameTurns::default(),
            stopping: Mutex::new(false),
            stop_wake: Condvar::new(),
            stop_turn: Mutex::new(()),
        }
    }

    /// Returns the store of the query history: the durable store of the engine, or memory for an engine
    /// without durability.
    pub(crate) fn files<'a>(&'a self, engine: &'a EngineInner) -> &'a dyn CheckpointStore {
        match &engine.durable {
            Some(durable) => durable.files(),
            None => &self.memory_files,
        }
    }

    /// Returns the scrambler of the engine's key, or `None` where the engine has no key.
    pub(crate) fn scrambler(&self) -> Option<&Scrambler> {
        self.scrambler.as_ref()
    }

    /// Returns the scrambler of the engine's key, refusing an engine without a key with `CONFIG_INVALID`.
    pub(crate) fn require_scrambler(&self) -> Result<&Scrambler> {
        self.scrambler.as_ref().ok_or_else(|| {
            NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                "This engine has no query suggestions key, so it holds no counts",
            )
        })
    }

    /// Reports whether the engine is shutting down.
    pub(crate) fn is_stopping(&self) -> bool {
        *locked(&self.stopping)
    }

    /// Waits for `duration`, returning `true` at once where the engine starts to shut down meanwhile.
    pub(crate) fn pause(&self, duration: Duration) -> bool {
        let deadline = Instant::now() + duration;
        let mut stopping = locked(&self.stopping);
        while !*stopping {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            stopping = self
                .stop_wake
                .wait_timeout(stopping, deadline - now)
                .map(|(stopping, _)| stopping)
                .unwrap_or_else(|poisoned| poisoned.into_inner().0);
        }
        true
    }

    /// Returns the setting of `index_name` with every default filled in, failing with `INDEX_NOT_FOUND` for a
    /// missing index and with `QUERY_SUGGESTIONS_NOT_ENABLED` where the feature is off.
    pub(crate) fn enabled_setting(
        &self,
        engine: &EngineInner,
        index_name: &str,
    ) -> Result<ResolvedSetting> {
        let index = engine.open_index(index_name)?;
        match index.suggestion_state().setting.as_ref() {
            Some(setting) if setting.enabled => Ok(setting.resolve()),
            _ => Err(not_enabled(index_name)),
        }
    }

    fn context<'a>(&'a self, engine: &'a EngineInner) -> Option<DayContext<'a>> {
        Some(DayContext {
            engine,
            files: self.files(engine),
            scrambler: self.scrambler.as_ref()?,
        })
    }

    /// Writes every changed day of `index_name`.
    pub(crate) fn save_day(&self, engine: &EngineInner, index_name: &str) {
        if let Some(context) = self.context(engine) {
            self.days.save(&context, index_name);
        }
    }

    /// Writes the counts of every index, letting go of each day before `today`.
    pub(crate) fn retire_days(&self, engine: &EngineInner, today: &str) {
        if let Some(context) = self.context(engine) {
            for index_name in self.days.indexes() {
                self.days.retire(&context, &index_name, today);
            }
        }
    }

    /// Counts one search of `index_name` that a person followed with a click.
    pub(crate) fn record(
        &self,
        engine: &EngineInner,
        index_name: &str,
        query: &RecordedQuery,
    ) -> Result<RecordQueryResult> {
        if self.is_stopping() {
            return Err(shutting_down());
        }
        let setting = self.enabled_setting(engine, index_name)?;
        let Some(context) = self.context(engine) else {
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
        let outcome = match self
            .days
            .count(&context, index_name, &setting, wall_ms(), &request)?
        {
            Counted::Off => return Err(not_enabled(index_name)),
            Counted::Banned => RecordQueryOutcome::Banned,
            Counted::Outcome(counted) => outcome_of(counted),
        };
        if outcome == RecordQueryOutcome::Recorded {
            self.timers.save_soon(
                index_name,
                Duration::from_millis(u64::from(setting.save_interval_ms)),
            );
        }
        Ok(result_of(outcome))
    }

    /// Drops the counts of `index_name` and deletes every history file of it, after its setting turns the feature
    /// off.
    pub(crate) fn discard_history(&self, engine: &EngineInner, index_name: &str) -> Result<()> {
        self.timers.forget_save(index_name);
        self.days.discard(index_name);
        remove_history_folder(self.files(engine), index_name)
    }

    /// Forgets everything that the engine holds for a dropped index and deletes its history files.
    pub(crate) fn on_drop(&self, engine: &EngineInner, index_name: &str) {
        self.timers.forget_index(index_name);
        self.builds.forget(index_name);
        self.days.discard(index_name);
        let _ = remove_history_folder(self.files(engine), index_name);
    }

    /// Starts the runtime once the engine has recovered its indexes, unless the engine has no key and no index
    /// has the feature on.
    pub(crate) fn start(&self, engine: &Arc<EngineInner>) {
        let enabled: Vec<String> = suggestion_states(engine)
            .into_iter()
            .filter(|(_, state)| state.enabled())
            .map(|(name, _)| name)
            .collect();
        if self.scrambler.is_none() {
            if enabled.is_empty() {
                return;
            }
            for index_name in &enabled {
                warn(
                    engine,
                    index_name,
                    QuerySuggestionsWarningReason::NoKey,
                    None,
                    None,
                );
            }
            sweep_now(engine);
            return;
        }
        let _ = remove_restore_leftovers(self.files(engine));
        sweep_now(engine);
        self.timers.start(engine);
    }

    /// Stops the timers, waits for every build, and writes every changed day, before the engine closes its store.
    /// A second call waits for the first to finish.
    pub(crate) fn stop(&self, engine: &EngineInner) {
        let _turn = locked(&self.stop_turn);
        {
            let mut stopping = locked(&self.stopping);
            if *stopping {
                return;
            }
            *stopping = true;
            self.stop_wake.notify_all();
        }
        self.timers.stop();
        self.builds.settle();
        if let Some(context) = self.context(engine) {
            for index_name in self.days.indexes() {
                self.days.save(&context, &index_name);
            }
        }
    }
}
