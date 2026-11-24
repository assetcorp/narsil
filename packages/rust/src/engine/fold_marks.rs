use std::sync::Arc;

use super::analysis_change::record_pending;
use super::changes::analysis::{AnalysisTarget, config_under, holds_fold_marks, pending_of};
use super::durable::switch::{SwitchFailure, checkpoint_switch};
use super::index::IndexState;
use crate::error::Result;

/// Finishes a change whose `target` holds the terms that `index` has, under `generation`. Where `target` gives
/// the `fold_marks` setting that the index has, it clears any change that the metadata file of `index` records.
/// Otherwise it records the change in that file before it switches the setting, so that a crash before the switch
/// commits leaves a change that recovery finishes, and it clears the record where the switch fails before its
/// commit. Reports whether the setting changed.
pub(super) fn change_held_terms(
    index: &IndexState,
    target: &AnalysisTarget,
    generation: u64,
) -> Result<bool> {
    if holds_fold_marks(&index.config(), target) {
        record_pending(index, None)?;
        return Ok(false);
    }
    record_pending(index, Some(pending_of(target, generation)))?;
    match switch_fold_marks(index, target, generation) {
        Ok(()) => Ok(true),
        Err(SwitchFailure::BeforeCommit(error)) => {
            let _ = record_pending(index, None);
            Err(error)
        }
        Err(SwitchFailure::AtCommit(error)) => Err(error),
    }
}

/// Gives `index` the `fold_marks` setting of `target` with no rebuild, because folded matching changes no stored
/// token. A durable index commits a checkpoint that records the setting and `generation`, because recovery reads
/// the generation of the saved terms from the checkpoint, and it keeps its old setting where that checkpoint
/// fails. Each search reads the setting with the partitions that it searches, so it matches under the old
/// setting or the new one throughout.
pub(super) fn switch_fold_marks(
    index: &IndexState,
    target: &AnalysisTarget,
    generation: u64,
) -> Result<(), SwitchFailure> {
    let _writer = index.lock_writes().map_err(SwitchFailure::BeforeCommit)?;
    let previous_layout = index.partitions();
    let previous_config = index.config();
    let before = index.log().map(|log| log.metadata(index));
    index.replace_config(Arc::new(config_under(&previous_config, target)));
    index.publish_switched_layout(previous_layout.with_fold_marks(target.fold_marks));
    if let (Some(log), Some(before)) = (index.log(), before) {
        let mut metadata = log.metadata(index);
        metadata.analysis.fold_marks = target.fold_marks;
        metadata.analysis_generation = Some(generation);
        metadata.pending_analysis = None;
        if let Err(failure) = checkpoint_switch(index, log, metadata) {
            index.restore_layout(previous_layout);
            index.replace_config(previous_config);
            log.remember(before);
            return Err(failure);
        }
    }
    index.record_analysis_generation(generation);
    Ok(())
}
