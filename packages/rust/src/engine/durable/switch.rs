use super::checkpoint::{CheckpointPlan, build_checkpoint};
use super::log::IndexLog;
use crate::engine::index::IndexState;
use crate::error::NarsilError;
use crate::format::metadata::IndexMetadata;

/// Why a checkpoint of new partitions failed: before its commit, so the store holds the previous checkpoint, or
/// during its commit, so the store can hold either checkpoint.
pub(crate) enum SwitchFailure {
    BeforeCommit(NarsilError),
    AtCommit(NarsilError),
}

impl SwitchFailure {
    pub(crate) fn into_error(self) -> NarsilError {
        match self {
            SwitchFailure::BeforeCommit(error) | SwitchFailure::AtCommit(error) => error,
        }
    }
}

/// Writes a checkpoint of the partitions that `index` holds now and commits it with `metadata`, while the caller
/// holds the index's write lock, so that no write reaches the log between the change of partitions and the
/// checkpoint that records it.
pub(crate) fn checkpoint_switch(
    index: &IndexState,
    log: &IndexLog,
    metadata: IndexMetadata,
) -> Result<(), SwitchFailure> {
    let mut writer = log
        .backing()
        .begin_checkpoint(&index.name)
        .map_err(SwitchFailure::BeforeCommit)?;
    let partitions = index.partitions();
    let applied = log.applied_seq_nos();
    let plan = CheckpointPlan {
        applied: &applied,
        metadata,
        compaction_threshold: log.compaction_threshold(),
        upgraded: None,
    };
    let mut built = build_checkpoint(&mut writer, index, &partitions, plan)
        .map_err(SwitchFailure::BeforeCommit)?;
    let backing = log.backing();
    writer
        .commit(&built.manifest, &built.metadata, &mut || {
            built.adopt_vectors(backing, index)
        })
        .map_err(SwitchFailure::AtCommit)?;
    built.read_paged_from(backing);
    log.remember(built.metadata.clone());
    log.record_saved(built.saved.clone());
    log.checkpointed();
    built.apply(&partitions);
    Ok(())
}
