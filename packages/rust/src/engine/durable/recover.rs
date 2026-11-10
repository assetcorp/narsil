use super::backing::Backing;
use super::build::recovered_index;
use super::bundle::load_bundle;
use super::checkpoint::write_checkpoint;
use super::earlier::load_earlier_checkpoint;
use super::load::{load_current_checkpoint, restore_vector_bytes};
use super::log::IndexLog;
use crate::durability::recovery::{RecoveredIndex, StoredCheckpoint};
use crate::durability::store::DurabilityStore;
use crate::engine::EngineInner;
use crate::engine::events::{EarlierLayout, NarsilEvent, WorkStatus};
use crate::engine::index::IndexState;
use crate::engine::sync::settle_recovered_sync;
use crate::engine::writes::{replay_delete, replay_index};
use crate::error::{NarsilError, Result};
use crate::format::manifest::PartitionCheckpoint;
use crate::format::wal::{LogEntry, Operation};
use crate::index::partition::in_keyword_batch;
use crate::value::decode_document;
use std::sync::Arc;

fn apply_entry(index: &IndexState, entry: LogEntry) -> Result<()> {
    match entry.operation {
        Operation::Delete => replay_delete(index, &entry.document_id),
        Operation::Index => {
            let Some(bytes) = entry.document else {
                return Ok(());
            };
            let mut document = decode_document(&bytes)?;
            restore_vector_bytes(index, &mut document)?;
            replay_index(index, &entry.document_id, document)
        }
    }
}

fn replay_logs(
    store: &DurabilityStore,
    index: &IndexState,
    checkpoint: &[PartitionCheckpoint],
) -> Result<()> {
    let _writer = index.write_lock();
    let partitions = index.partitions();
    in_keyword_batch(&partitions, || {
        for partition_id in 0..partitions.len() {
            let mut visit = |entry: LogEntry| apply_entry(index, entry);
            store.replay_partition(&index.name, partition_id as u32, checkpoint, &mut visit)?;
        }
        Ok(())
    })
}

/// Rebuilds one stored index: its settings from the metadata file, its documents and vectors from the newest
/// checkpoint, and, under the log tier, every later write from the write-ahead log of each partition. The engine
/// reports the rewrite of an index that an earlier release saved to the listeners of layout upgrades.
pub(super) fn recover_index(
    engine: &EngineInner,
    backing: &Backing,
    compaction_threshold: u32,
    name: &str,
) -> Result<Option<Arc<IndexState>>> {
    let Some(mut recovered) = backing.open_index(name)? else {
        return Ok(None);
    };
    if settle_recovered_sync(&mut recovered.metadata)? {
        recovered.metadata_changed = true;
    }
    let index = Arc::new(recovered_index(engine, &recovered.metadata)?);
    let earlier = match &recovered.checkpoint {
        StoredCheckpoint::Earlier(_) => Some(EarlierLayout::Manifest),
        StoredCheckpoint::Bundle(_) => Some(EarlierLayout::Bundle),
        StoredCheckpoint::Empty | StoredCheckpoint::Current(_) => None,
    };
    let report = |status: WorkStatus, error: Option<NarsilError>| {
        if let Some(layout) = earlier {
            engine.events.emit(NarsilEvent::LayoutUpgrade {
                index_name: name.to_string(),
                status,
                layout,
                error,
            });
        }
    };
    report(WorkStatus::Started, None);
    match load_recovered(backing, &index, recovered, compaction_threshold) {
        Ok(()) => report(WorkStatus::Completed, None),
        Err(error) => {
            report(WorkStatus::Failed, Some(error.clone()));
            return Err(error);
        }
    }
    Ok(Some(index))
}

fn load_recovered(
    backing: &Backing,
    index: &Arc<IndexState>,
    recovered: RecoveredIndex,
    compaction_threshold: u32,
) -> Result<()> {
    let (checkpoint, upgraded) = match &recovered.checkpoint {
        StoredCheckpoint::Empty => (Vec::new(), None),
        StoredCheckpoint::Current(manifest) => {
            load_current_checkpoint(backing, index, manifest)?;
            (manifest.checkpoint.clone(), None)
        }
        StoredCheckpoint::Earlier(manifest) => {
            let loaded = load_earlier_checkpoint(backing, index, manifest)?;
            (loaded.checkpoint, Some(loaded.prior))
        }
        StoredCheckpoint::Bundle(payload) => {
            let loaded = load_bundle(index, payload)?;
            (loaded.checkpoint, Some(loaded.prior))
        }
    };
    let log = IndexLog::new(backing.clone(), recovered.metadata, compaction_threshold);
    match backing {
        Backing::Log(store) => replay_logs(store, index, &checkpoint)?,
        Backing::Snapshot(_) => {
            let reached: Vec<(u32, u64)> = checkpoint
                .iter()
                .map(|entry| (entry.partition_id, entry.last_seq_no))
                .collect();
            log.resume_after(&reached);
        }
    }
    index.attach_log(log);
    if let Some(log) = index.log() {
        if let Some(prior) = &upgraded {
            write_checkpoint(index, log, Some(prior))?;
        }
        if upgraded.is_some() || recovered.metadata_changed {
            log.write_metadata(index)?;
        }
    }
    Ok(())
}

/// Recovers every index that the store holds, in name order, and adds each one to the engine.
pub(crate) fn recover_indexes(
    engine: &EngineInner,
    backing: &Backing,
    compaction_threshold: u32,
) -> Result<()> {
    for name in backing.index_names()? {
        if let Some(index) = recover_index(engine, backing, compaction_threshold, &name)? {
            engine.indexes_mut().insert(name, index);
        }
    }
    Ok(())
}
