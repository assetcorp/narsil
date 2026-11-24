use std::sync::Arc;

use super::analysis_change::record_pending;
use super::changes::analysis::{AnalysisTarget, config_under, holds_fold_marks};
use super::index::IndexState;
use crate::error::Result;

/// Finishes a change whose `target` holds the terms that `index` has, which clears any change that the metadata
/// file of `index` records and switches the `fold_marks` setting where `target` gives a different one, under
/// `generation`. Reports whether the setting changed.
pub(super) fn change_held_terms(
    index: &IndexState,
    target: &AnalysisTarget,
    generation: u64,
) -> Result<bool> {
    record_pending(index, None)?;
    if holds_fold_marks(&index.config(), target) {
        return Ok(false);
    }
    switch_fold_marks(index, target, generation)?;
    Ok(true)
}

/// Gives `index` the `fold_marks` setting of `target` with no rebuild, because folded matching changes no stored
/// token. A durable index records the setting and the next analysis generation in its metadata file first, and
/// keeps its old setting where that write fails. Each search reads the setting with the partitions that it
/// searches, so it matches under the old setting or the new one throughout.
pub(super) fn switch_fold_marks(
    index: &IndexState,
    target: &AnalysisTarget,
    generation: u64,
) -> Result<()> {
    let _writer = index.lock_writes()?;
    let config = Arc::new(config_under(&index.config(), target));
    if let Some(log) = index.log() {
        let mut metadata = log.metadata(index);
        metadata.analysis.fold_marks = target.fold_marks;
        metadata.analysis_generation = Some(generation);
        metadata.pending_analysis = None;
        log.write_recorded(metadata)?;
    }
    let layout = index.partitions().with_fold_marks(target.fold_marks);
    index.replace_config(config);
    index.publish_switched_layout(layout);
    index.record_analysis_generation(generation);
    Ok(())
}
