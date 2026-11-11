use std::sync::Arc;

use super::changes::analysis::{
    AnalysisChange, AnalysisTarget, config_under, holds_target, pending_of, pending_target,
    resolve_target,
};
use super::changes::drive::{DriveHooks, rebuild_and_switch};
use super::changes::rebuild::Rebuild;
use super::changes::switch::{LayoutSwitch, switch_layout};
use super::changes::{ChangeKind, ChangeTicket};
use super::durable::switch::SwitchFailure;
use super::events::{NarsilEvent, WorkStatus};
use super::index::IndexState;
use super::layout::TextLayout;
use super::memory::require_analysis_rebuild_memory;
use super::stats::text_bytes;
use super::synonyms::prepare_synonyms;
use super::{EngineInner, Narsil};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::metadata::IndexMetadata;
use crate::format::metadata_parts::PendingAnalysis;
use crate::index::constants::ARRAY_POSITION_GAP;
use crate::index::partition::Partition;

fn recorded_pending(index: &IndexState) -> Option<PendingAnalysis> {
    index
        .log()
        .and_then(|log| log.metadata(index).pending_analysis)
}

/// Records `pending` as the analysis change that the index's metadata file holds, under the index's write lock so
/// that no other metadata write of the index runs in between.
fn record_pending(index: &IndexState, pending: Option<PendingAnalysis>) -> Result<()> {
    let Some(log) = index.log() else {
        return Ok(());
    };
    let _writer = index.lock_writes()?;
    let mut metadata = log.metadata(index);
    if metadata.pending_analysis == pending {
        return Ok(());
    }
    metadata.pending_analysis = pending;
    log.write_recorded(metadata)
}

fn next_generation(index: &IndexState) -> u64 {
    let Some(log) = index.log() else {
        return 1;
    };
    let metadata = log.metadata(index);
    let pending = metadata
        .pending_analysis
        .map_or(0, |pending| pending.generation);
    metadata
        .analysis_generation
        .unwrap_or(0)
        .max(pending)
        .saturating_add(1)
}

fn rebuild_event(
    index: &IndexState,
    status: WorkStatus,
    partitions_rebuilt: usize,
    error: Option<NarsilError>,
) -> NarsilEvent {
    NarsilEvent::AnalysisRebuild {
        index_name: index.name.clone(),
        status,
        partitions_rebuilt,
        partition_count: index.partitions().len(),
        error,
    }
}

/// The result of one rebuild, with the event that reports how it ended, which the caller raises once it frees the
/// index's change slot, so that a listener of that event can start another change.
type Finished<T> = (T, Option<NarsilEvent>);

fn announce<T>(engine: &EngineInner, ticket: ChangeTicket<'_>, (result, event): Finished<T>) -> T {
    drop(ticket);
    if let Some(event) = event {
        engine.events.emit(event);
    }
    result
}

fn changed_under_change(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::ANALYSIS_CHANGE_REPLACED,
        format!(
            "The partitions of index \"{index_name}\" changed while its terms were rebuilt, so try the change again"
        ),
    )
}

fn refused_during_rebalance(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PARTITION_REBALANCING_BACKPRESSURE,
        format!(
            "Index \"{index_name}\" is being rebalanced, so try its analysis change again once the rebalance ends"
        ),
    )
}

/// Rebuilds the terms of `index` under `target` while the index keeps answering searches from its old terms, and
/// switches to the new terms once they hold every write. A change of settings records `generation` as the
/// analysis that the new terms come from.
fn rebuild_under(
    engine: &EngineInner,
    index: &IndexState,
    ticket: &ChangeTicket<'_>,
    target: &AnalysisTarget,
    generation: Option<u64>,
) -> Finished<Result<(), SwitchFailure>> {
    let partition_count = index.partitions().len();
    engine
        .events
        .emit(rebuild_event(index, WorkStatus::Started, 0, None));
    let rebuild = Rebuild {
        engine,
        index,
        ticket,
        analyser: &target.analyser,
        partition_count,
    };
    let revision = target.language.revision().to_string();
    let record = |metadata: &mut IndexMetadata| {
        if let Some(generation) = generation {
            metadata.analysis_generation = Some(generation);
            metadata.pending_analysis = None;
        }
        metadata.analysis_revision = Some(revision.clone());
        metadata.array_position_gap = Some(f64::from(ARRAY_POSITION_GAP));
    };
    let mut switch = |built: Vec<Arc<Partition>>| {
        let current = index.partitions();
        let synonyms = prepare_synonyms(
            Some(current.synonyms.rules.as_slice()),
            &target.analyser,
            false,
            "",
        )
        .map_err(SwitchFailure::BeforeCommit)?;
        let layout = TextLayout {
            partitions: built,
            analyser: target.analyser.clone(),
            synonyms: Arc::new(synonyms),
        };
        let config = Arc::new(config_under(&index.config(), target));
        switch_layout(
            index,
            LayoutSwitch {
                layout,
                config,
                record: &record,
            },
        )
    };
    let mut rebuilt = 0;
    let mut progress = |done: usize| rebuilt = done;
    let interrupted = || changed_under_change(&index.name);
    let hooks = DriveHooks {
        progress: &mut progress,
        interrupted: &interrupted,
        switch: &mut switch,
    };
    let outcome = rebuild_and_switch(&rebuild, hooks);
    let event = match &outcome {
        Ok(()) => {
            index.set_analysis_stale(false);
            rebuild_event(index, WorkStatus::Completed, partition_count, None)
        }
        Err(SwitchFailure::BeforeCommit(error) | SwitchFailure::AtCommit(error)) => {
            rebuild_event(index, WorkStatus::Failed, rebuilt, Some(error.clone()))
        }
    };
    (outcome, Some(event))
}

/// Goes on with the analysis change that `pending` records, keeping the record where the change fails, so that a
/// later restart or rebuild tries it again.
fn resume(
    engine: &EngineInner,
    index: &IndexState,
    ticket: &ChangeTicket<'_>,
    pending: &PendingAnalysis,
) -> Finished<Result<()>> {
    let checked = pending_target(engine, index, pending).and_then(|target| {
        require_analysis_rebuild_memory(&index.name, text_bytes(index))?;
        Ok(target)
    });
    let target = match checked {
        Ok(target) => target,
        Err(error) => {
            let event = rebuild_event(index, WorkStatus::Failed, 0, Some(error.clone()));
            return (Err(error), Some(event));
        }
    };
    let (outcome, event) = rebuild_under(engine, index, ticket, &target, Some(pending.generation));
    (outcome.map_err(SwitchFailure::into_error), event)
}

fn change_index_analysis(
    engine: &EngineInner,
    index: &IndexState,
    change: &AnalysisChange,
) -> Result<()> {
    if index.changes.is_rebalancing() {
        return Err(refused_during_rebalance(&index.name));
    }
    let target = resolve_target(engine, index, change)?;
    let held = holds_target(&index.config(), &target);
    if held && !index.changes.runs(ChangeKind::Analysis) {
        return Ok(());
    }
    if !held {
        let synonyms = index.synonym_set();
        prepare_synonyms(Some(synonyms.rules.as_slice()), &target.analyser, true, "")?;
        require_analysis_rebuild_memory(&index.name, text_bytes(index))?;
    }
    let ticket = index
        .changes
        .claim(ChangeKind::Analysis, &index.name, true)?;
    let rebuild = Rebuild {
        engine,
        index,
        ticket: &ticket,
        analyser: &target.analyser,
        partition_count: 0,
    };
    rebuild.require_current()?;
    if holds_target(&index.config(), &target) {
        return record_pending(index, None);
    }
    let generation = next_generation(index);
    record_pending(index, Some(pending_of(&target, generation)))?;
    let (outcome, event) = rebuild_under(engine, index, &ticket, &target, Some(generation));
    let result = match outcome {
        Ok(()) => Ok(()),
        Err(failure) => {
            let still_owned = !ticket.stopped() && !index.is_retired();
            if matches!(failure, SwitchFailure::BeforeCommit(_))
                && still_owned
                && engine.guard_shutdown().is_ok()
            {
                let _ = record_pending(index, None);
            }
            Err(failure.into_error())
        }
    };
    announce(engine, ticket, (result, event))
}

fn rebuild_index_analysis(engine: &EngineInner, index: &IndexState) -> Result<()> {
    let ticket = index
        .changes
        .claim(ChangeKind::Analysis, &index.name, false)?;
    if let Some(pending) = recorded_pending(index) {
        let finished = resume(engine, index, &ticket, &pending);
        return announce(engine, ticket, finished);
    }
    if !index.analysis_stale() {
        return Ok(());
    }
    let config = index.config();
    let target = AnalysisTarget {
        language: index.analyser().language().clone(),
        tokenizer: config.tokenizer.clone(),
        stop_words: config.stop_words.clone(),
        analyser: index.analyser(),
    };
    let (outcome, event) = rebuild_under(engine, index, &ticket, &target, None);
    announce(
        engine,
        ticket,
        (outcome.map_err(SwitchFailure::into_error), event),
    )
}

/// Reports whether the metadata file of `index` records an analysis change that has not finished.
pub(crate) fn has_pending_change(index: &IndexState) -> bool {
    recorded_pending(index).is_some()
}

/// Rebuilds the terms of the index called `name`, or finishes the analysis change that it records, and runs the
/// rebuild again on the index that took the name where a close or a restore retired the index meanwhile.
pub(crate) fn rebuild_named(engine: &EngineInner, name: &str) -> Result<()> {
    let mut reached = None;
    let outcome = engine.on_current_index(name, |index| {
        reached = Some(index.name.clone());
        rebuild_index_analysis(engine, index)
    });
    if let Some(name) = reached {
        engine.events.wrote(&name);
    }
    outcome
}

/// Goes on with the analysis change that the metadata file of `index` records, on a separate thread, so that the
/// engine finishes each change that it accepted before a restart or a close.
pub(crate) fn resume_interrupted_change(engine: &Arc<EngineInner>, index: &Arc<IndexState>) {
    if recorded_pending(index).is_none() {
        return;
    }
    let engine = Arc::clone(engine);
    let index = Arc::clone(index);
    let _ = std::thread::Builder::new()
        .name(format!("narsil-analysis-{}", index.name))
        .spawn(move || {
            let Ok(ticket) = index
                .changes
                .claim(ChangeKind::Analysis, &index.name, false)
            else {
                return;
            };
            if index.is_retired() {
                return;
            }
            let Some(pending) = recorded_pending(&index) else {
                return;
            };
            let finished = resume(&engine, &index, &ticket, &pending);
            let _ = announce(&engine, ticket, finished);
            engine.events.wrote(&index.name);
        });
}

/// Goes on with every analysis change that a restart interrupted, each on a separate thread.
pub(crate) fn resume_interrupted_changes(engine: &Arc<EngineInner>) {
    for index in engine.index_list() {
        resume_interrupted_change(engine, &index);
    }
}

impl Narsil {
    /// Gives an index that matches text under new analysis settings, once the new terms answer every search.
    ///
    /// The engine builds the new terms beside the old ones while searches keep matching under the old settings and
    /// writes keep arriving, and each search matches under one set of settings. A durable engine first records the
    /// change in the index's metadata, then commits a checkpoint of the new terms as it switches, and goes on with
    /// the change after a restart at any point before that checkpoint. A change to the settings that the index
    /// already holds completes with no rebuild, and a later change stops one that runs.
    ///
    /// Fails with `LANGUAGE_NOT_SUPPORTED` for an unknown language, with `CONFIG_INVALID` for an unregistered
    /// name, a stop word function, or a synonym word that breaks the synonym rules under the new settings, with
    /// `ANALYSIS_CHANGE_REPLACED` where a later change replaces this one, with `PARTITION_REBALANCING_BACKPRESSURE`
    /// during a rebalance, with `ANALYSIS_REBUILD_MEMORY_EXCEEDED` where a second copy of the index's terms would
    /// pass the process's memory limit, and with `PERSISTENCE_SAVE_FAILED` where the checkpoint fails, which
    /// leaves the old terms answering.
    pub fn change_analysis(&self, index: &str, change: &AnalysisChange) -> Result<()> {
        let mut reached = None;
        let outcome = self.inner.on_current_index(index, |state| {
            reached = Some(state.name.clone());
            change_index_analysis(&self.inner, state, change)
        });
        if let Some(name) = reached {
            self.inner.events.wrote(&name);
        }
        outcome
    }

    /// Rebuilds the terms of an index whose results report `analysis_stale`, under the analysis that its settings
    /// give now, and finishes an analysis change that a restart interrupted. An index whose terms are current
    /// returns at once.
    ///
    /// Fails as [`Narsil::change_analysis`] does.
    pub fn rebuild_analysis(&self, index: &str) -> Result<()> {
        rebuild_named(&self.inner, index)
    }
}
