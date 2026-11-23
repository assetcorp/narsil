use std::sync::Arc;

use super::analysis_change::{announce, rebuild_under, record_pending};
use super::changes::analysis::{AnalysisChange, pending_of, pending_target, resolve_config_target};
use super::changes::drive::KeepCurrent;
use super::changes::hold::HeldRun;
use super::changes::rebuild::Rebuild;
use super::changes::{ChangeKind, replaced};
use super::durable::switch::{SwitchFailure, checkpoint_switch};
use super::index::IndexState;
use super::memory::require_analysis_rebuild_memory;
use super::stats::text_bytes;
use super::sync::notify::announcing_epoch;
use super::synonyms::prepare_synonyms;
use super::{EngineInner, Narsil};
use crate::config::IndexConfig;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::metadata_parts::{NamedAnalysis, PendingAnalysis};

/// The analysis settings of a change that a cluster's controller records for an index, with the generation that
/// the controller gives the change.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PendingAnalysisChange {
    /// The generation of the change, which grows by one with each change of the index's analysis.
    pub generation: u64,
    /// The name of the language, such as `english`.
    pub language: String,
    /// The name of a tokenizer that [`crate::Narsil::register_tokenizer`] bound, or `None` for the language's.
    pub tokenizer: Option<String>,
    /// The name of a registered stop word set.
    pub stop_words: Option<String>,
    /// A list of stop words, which applies where `stop_words` gives no name.
    pub stop_word_list: Option<Vec<String>>,
}

impl PendingAnalysisChange {
    fn recorded(&self) -> PendingAnalysis {
        let stop_word_list = self.stop_word_list.as_ref().map(|words| {
            let mut list = words.clone();
            list.sort_unstable();
            list.dedup();
            list
        });
        PendingAnalysis {
            generation: self.generation,
            language: self.language.clone(),
            analysis: NamedAnalysis {
                tokenizer: self.tokenizer.clone(),
                stop_words: self.stop_words.clone(),
                stop_word_list,
            },
        }
    }
}

/// The calls that a cluster node makes to change an index's analysis in step with the cluster's controller. The
/// node builds the new terms beside the old ones, and switches to them once the controller publishes their
/// generation. Every call blocks, so an async caller runs it off its executor.
pub struct HeldAnalysisChanges<'a> {
    engine: &'a Arc<EngineInner>,
}

impl<'a> HeldAnalysisChanges<'a> {
    /// Returns the calls on the indexes that `engine` holds.
    pub fn new(engine: &'a Narsil) -> HeldAnalysisChanges<'a> {
        HeldAnalysisChanges {
            engine: &engine.inner,
        }
    }

    /// Returns the analysis settings that `change` moves an index called `index` with `config` to, with a
    /// generation of 0 for the caller to give, so that a cluster node can refuse a change before it records the
    /// change as pending. The index need not be open in this engine, and `config` carries the index's synonym rules.
    ///
    /// Fails with `LANGUAGE_NOT_SUPPORTED` for a language that this engine does not hold, and with
    /// `CONFIG_INVALID` for a tokenizer or stop word name that this engine has not registered, a stop word function,
    /// settings past the configuration size limit, or a synonym word that breaks the synonym rules under the new
    /// settings.
    pub fn check_analysis_change(
        &self,
        index: &str,
        config: &IndexConfig,
        change: &AnalysisChange,
    ) -> Result<PendingAnalysisChange> {
        check_analysis_change(self.engine, index, config, change)
    }

    /// Builds the terms of the index called `index` under `pending` beside its old terms, and returns once they are
    /// built, while searches keep matching under the old terms. The new terms then take every write and wait for
    /// [`HeldAnalysisChanges::release_held_analysis`]. An index whose generation already reaches the change's
    /// returns at once, and a call for the change that waits already returns once that change is built.
    ///
    /// Fails as [`crate::Narsil::change_analysis`] does, and with `ANALYSIS_CHANGE_REPLACED` where a drop, a later
    /// change, a close, or a restore stops the change before its terms are built.
    pub fn build_held_analysis(&self, index: &str, pending: &PendingAnalysisChange) -> Result<()> {
        build_held_analysis(self.engine, index, pending.recorded())
    }

    /// Reports whether the terms of the change with `generation` are built and wait for their release.
    pub fn held_analysis_is_built(&self, index: &str, generation: u64) -> bool {
        self.engine
            .open_index_named(index)
            .and_then(|state| state.changes.held_run())
            .is_some_and(|run| run.pending.generation == generation && run.is_built())
    }

    /// Lets the held change with `generation` switch to its new terms, and returns once they answer every search.
    /// Returns at once where no held change has that generation.
    ///
    /// Fails with the error that ended the change, which leaves the change recorded as pending.
    pub fn release_held_analysis(&self, index: &str, generation: u64) -> Result<()> {
        release_held_analysis(self.engine, index, generation)
    }

    /// Stops the analysis change that runs on the index, held or not, and clears the change that its metadata
    /// records as pending.
    pub fn drop_held_analysis(&self, index: &str) -> Result<()> {
        drop_held_analysis(self.engine, index)
    }

    /// Records `generation` as the analysis generation of an index whose terms already come from that analysis,
    /// and clears its pending change, in a checkpoint of a durable index. A lower generation changes nothing.
    pub fn stamp_analysis_generation(&self, index: &str, generation: u64) -> Result<()> {
        stamp_analysis_generation(self.engine, index, generation)
    }
}

fn current_generation(index: &IndexState) -> u64 {
    index.log().map_or(0, |log| {
        log.metadata(index).analysis_generation.unwrap_or(0)
    })
}

fn serves(run: &HeldRun, pending: &PendingAnalysis) -> bool {
    run.pending == *pending
}

fn start_failed(index_name: &str, error: &std::io::Error) -> NarsilError {
    NarsilError::new(
        ErrorCode::INTERNAL_ERROR,
        format!("The analysis change of index \"{index_name}\" could not start a thread: {error}"),
    )
}

fn drive_held(engine: &EngineInner, index: &IndexState, run: &HeldRun) -> Result<()> {
    let ticket = index
        .changes
        .claim(ChangeKind::Analysis, &index.name, true)?;
    if run.is_stopped() {
        return announce(engine, ticket, (Err(replaced(&index.name)), None));
    }
    let finished = {
        let target = pending_target(engine, index, &run.pending);
        let checked = target.and_then(|target| {
            let rebuild = Rebuild {
                engine,
                index,
                ticket: &ticket,
                analyser: &target.analyser,
                partition_count: 0,
            };
            rebuild.require_current()?;
            record_pending(index, Some(run.pending.clone()))?;
            Ok(target)
        });
        match checked {
            Err(error) => (Err(error), None),
            Ok(_) if run.is_stopped() => (Err(replaced(&index.name)), None),
            Ok(target) => {
                let hold = |keep_current: &mut KeepCurrent<'_>| {
                    run.wait_for_release(&ticket, &index.name, keep_current)
                };
                let generation = Some(run.pending.generation);
                let (outcome, event) =
                    rebuild_under(engine, index, &ticket, &target, generation, Some(&hold));
                (outcome.map_err(SwitchFailure::into_error), event)
            }
        }
    };
    announce(engine, ticket, finished)
}

fn start_held_run(
    engine: &Arc<EngineInner>,
    index: &Arc<IndexState>,
    pending: PendingAnalysis,
) -> Result<Option<Arc<HeldRun>>> {
    if current_generation(index) >= pending.generation {
        return Ok(None);
    }
    if let Some(previous) = index.changes.held_run()
        && serves(&previous, &pending)
    {
        return Ok(Some(previous));
    }
    let target = pending_target(engine, index, &pending)?;
    let synonyms = index.synonym_set();
    prepare_synonyms(Some(synonyms.rules.as_slice()), &target.analyser, true, "")?;
    require_analysis_rebuild_memory(&index.name, text_bytes(index))?;
    let started = Arc::new(HeldRun::new(pending));
    let (run, replaced) = index.changes.hold_run(Arc::clone(&started));
    if !Arc::ptr_eq(&run, &started) {
        return Ok(Some(run));
    }
    if let Some(previous) = replaced {
        previous.stop();
    }
    let thread_engine = Arc::clone(engine);
    let thread_index = Arc::clone(index);
    let thread_run = Arc::clone(&run);
    let spawned = std::thread::Builder::new()
        .name(format!("narsil-held-analysis-{}", index.name))
        .spawn(move || {
            let outcome = announcing_epoch(&thread_engine, &thread_index.name, || {
                drive_held(&thread_engine, &thread_index, &thread_run)
            });
            thread_index.changes.forget_held_run(&thread_run);
            thread_run.finish(outcome);
            thread_engine.events.wrote(&thread_index.name);
        });
    if let Err(error) = spawned {
        let error = start_failed(&index.name, &error);
        index.changes.forget_held_run(&run);
        run.finish(Err(error.clone()));
        return Err(error);
    }
    Ok(Some(run))
}

pub(crate) fn check_analysis_change(
    engine: &EngineInner,
    name: &str,
    config: &IndexConfig,
    change: &AnalysisChange,
) -> Result<PendingAnalysisChange> {
    let target = resolve_config_target(engine, name, config, change)?;
    prepare_synonyms(config.synonyms.as_deref(), &target.analyser, true, "")?;
    let PendingAnalysis {
        generation,
        language,
        analysis,
    } = pending_of(&target, 0);
    Ok(PendingAnalysisChange {
        generation,
        language,
        tokenizer: analysis.tokenizer,
        stop_words: analysis.stop_words,
        stop_word_list: analysis.stop_word_list,
    })
}

pub(crate) fn build_held_analysis(
    engine: &Arc<EngineInner>,
    name: &str,
    pending: PendingAnalysis,
) -> Result<()> {
    let index = engine.open_index(name)?;
    if let Some(running) = index.changes.held_run()
        && serves(&running, &pending)
    {
        return running.wait_ready();
    }
    match start_held_run(engine, &index, pending)? {
        Some(run) => run.wait_ready(),
        None => Ok(()),
    }
}

pub(crate) fn release_held_analysis(
    engine: &EngineInner,
    name: &str,
    generation: u64,
) -> Result<()> {
    let Some(run) = engine
        .open_index_named(name)
        .and_then(|index| index.changes.held_run())
    else {
        return Ok(());
    };
    if run.pending.generation != generation {
        return Ok(());
    }
    run.release();
    run.wait_finished()
}

pub(crate) fn drop_held_analysis(engine: &EngineInner, name: &str) -> Result<()> {
    let Some(index) = engine.open_index_named(name) else {
        return Ok(());
    };
    let held = index.changes.held_run();
    if let Some(run) = &held {
        run.stop();
    }
    let ticket = match index.changes.claim(ChangeKind::Analysis, &index.name, true) {
        Ok(ticket) => Some(ticket),
        Err(error) if error.code() == ErrorCode::PARTITION_REBALANCING_BACKPRESSURE => None,
        Err(error) => return Err(error),
    };
    let cleared = match index.is_retired() {
        true => Ok(()),
        false => record_pending(&index, None),
    };
    drop(ticket);
    if let Some(run) = held {
        let _ = run.wait_finished();
    }
    cleared
}

pub(crate) fn stamp_analysis_generation(
    engine: &EngineInner,
    name: &str,
    generation: u64,
) -> Result<()> {
    let index = engine.open_index(name)?;
    let Some(log) = index.log() else {
        return Ok(());
    };
    let _writer = index.lock_writes()?;
    let mut metadata = log.metadata(&index);
    if metadata.analysis_generation.unwrap_or(0) >= generation {
        return Ok(());
    }
    metadata.analysis_generation = Some(generation);
    metadata.pending_analysis = None;
    checkpoint_switch(&index, log, metadata).map_err(SwitchFailure::into_error)
}
