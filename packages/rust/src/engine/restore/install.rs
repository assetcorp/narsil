use std::sync::Arc;

use super::prepare::PreparedIndex;
use crate::durability::checkpoint_store::{AdapterStore, CheckpointStore};
use crate::durability::persistence::MemoryPersistence;
use crate::durability::restore::RestoreStaging;
use crate::engine::EngineInner;
use crate::engine::durable::load::load_current_checkpoint;
use crate::engine::durable::load_source::StagedSource;
use crate::engine::durable::metadata::metadata_of;
use crate::engine::index::IndexState;
use crate::engine::memory::constants::RESTORE_PROCESS_BYTES_PER_STORED_BYTE;
use crate::engine::memory::require_restore_memory;
use crate::engine::query_suggestions::restore_hooks::{
    after_activate, before_install, publish_without_source_bans,
};
use crate::engine::sync::carry_sync_onto;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::manifest::SegmentManifest;
use crate::format::metadata::IndexMetadata;
use crate::index::constants::ARRAY_POSITION_GAP;
use crate::schema::BaseType;

/// Where a restore keeps the files that it reads from its source until the index takes them: the engine's store,
/// under a staging name, or memory for an engine that keeps no files.
pub(super) enum Staging<'d> {
    Stored(RestoreStaging<'d>),
    Memory(AdapterStore),
}

impl<'d> Staging<'d> {
    /// Opens the staging of a restore of `index_name`.
    pub(super) fn begin(engine: &'d EngineInner, index_name: &str) -> Result<Staging<'d>> {
        match &engine.durable {
            Some(durable) => Ok(Staging::Stored(durable.begin_restore(index_name)?)),
            None => Ok(Staging::Memory(AdapterStore::new(Arc::new(
                MemoryPersistence::new(),
            )))),
        }
    }

    pub(super) fn store(&self) -> &dyn CheckpointStore {
        match self {
            Staging::Stored(staging) => staging,
            Staging::Memory(store) => store,
        }
    }

    /// Removes every file that the restore staged and did not commit.
    pub(super) fn discard(&self) {
        if let Staging::Stored(staging) = self {
            let _ = staging.discard();
        }
    }
}

fn holds_string_list_field(index: &IndexState) -> bool {
    index
        .schema
        .fields
        .iter()
        .any(|field| field.field_type.base == BaseType::StringList)
}

/// Reports whether the restored terms came from another analysis than the index's language module and settings
/// produce now, which a search reports until the index rebuilds its terms.
fn restored_analysis_stale(index: &IndexState, recorded: &IndexMetadata) -> bool {
    let language = index.analyser().language().clone();
    if recorded.analysis_revision.as_deref() != Some(language.revision()) {
        return true;
    }
    recorded.array_position_gap != Some(f64::from(ARRAY_POSITION_GAP))
        && index.config().track_positions != Some(false)
        && holds_string_list_field(index)
}

/// Loads the staged checkpoint into the prepared index, then puts the index in the engine as [`activate`] does.
pub(super) fn install(
    engine: &EngineInner,
    prepared: PreparedIndex,
    manifest: &SegmentManifest,
    staging: &mut Staging<'_>,
) -> Result<()> {
    let PreparedIndex { index, recorded } = prepared;
    let replaces_index = engine.holds_index(&index.name);
    let stored_bytes = manifest
        .file_refs()
        .iter()
        .fold(0u64, |total, file| total.saturating_add(file.bytes));
    require_restore_memory(
        &index.name,
        stored_bytes.saturating_mul(RESTORE_PROCESS_BYTES_PER_STORED_BYTE),
        replaces_index,
    )?;
    load_current_checkpoint(&StagedSource(staging.store()), &index, manifest)?;
    activate(engine, index, &recorded, Some(manifest), staging)
}

fn missing_manifest(name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!("The restore of index \"{name}\" staged its files without a manifest"),
    )
}

/// Puts a restored index in the engine under its name, replacing the index that held the name before, whose
/// files the files that `staging` holds replace in the same step.
///
/// The old index keeps serving until the swap, and its write lock is held across the swap so that no write lands
/// in a log that the restored index then owns. A failure before the store commits the swap leaves the old index
/// and its files as they were.
pub(super) fn activate(
    engine: &EngineInner,
    index: IndexState,
    recorded: &IndexMetadata,
    manifest: Option<&SegmentManifest>,
    staging: &mut Staging<'_>,
) -> Result<()> {
    before_install(engine, &index)?;
    let previous = engine.index(&index.name).ok();
    let mut metadata = metadata_of(&index, recorded);
    let replaced = match (&previous, &engine.durable) {
        (Some(old), _) => old.log().map(|log| log.metadata(old)),
        (None, Some(durable)) if engine.lifecycle.holds_closed(&index.name) => {
            durable.stored_metadata(&index.name)?
        }
        (None, _) => None,
    };
    if let Some(replaced) = replaced {
        carry_sync_onto(&mut metadata, &replaced)?;
    }
    if let Staging::Stored(staged) = &*staging {
        let manifest = manifest.ok_or_else(|| missing_manifest(&index.name))?;
        staged.stage_commit(manifest, &metadata)?;
    }
    index.set_analysis_stale(restored_analysis_stale(&index, recorded));
    let index = Arc::new(index);
    let writer = previous.as_ref().map(|old| old.write_lock());
    if let (Staging::Stored(staged), Some(durable), Some(manifest)) =
        (&mut *staging, &engine.durable, manifest)
    {
        let log = durable.adopt_restore(staged, &manifest.checkpoint, metadata)?;
        index.attach_log(log);
    }
    publish_without_source_bans(engine, &index, || {
        engine
            .indexes_mut()
            .insert(index.name.clone(), Arc::clone(&index));
    });
    engine.lifecycle.forget(&index.name);
    engine.lifecycle.touch(&index);
    if let Some(old) = &previous {
        old.retire();
    }
    drop(writer);
    if let Staging::Stored(staged) = staging {
        let _ = staged.remove_retired();
    }
    after_activate(engine, &index.name);
    Ok(())
}
