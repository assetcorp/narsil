use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use super::backing::{Backing, CheckpointTarget};
use super::checkpoint_listing::{listed_as_before, listed_with_changes, unchanged_since};
use super::checkpoint_positions::partition_checkpoints;
use super::checkpoint_segments::{SavedSegment, SegmentWriter};
use super::checkpoint_vectors::{WrittenField, vector_files_still_read, write_vector_fields};
use super::compaction::{WindowMerge, choose_window, merge_window};
use super::config::CheckpointLimits;
use super::log::IndexLog;
use super::removed_documents::{RewriteBudget, rewrite_removed_documents};
use super::saved_size::SavedSize;
use crate::config::Storage;
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::format::manifest::{PartitionEntry, SegmentManifest};
use crate::format::metadata::IndexMetadata;
use crate::index::partition::{Partition, PartitionSnapshot};
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::schema::flatten_schema;

/// What a checkpoint changes in one partition once it commits: each written segment, and whether the written
/// segments replace every segment of the partition.
struct PartitionSwap {
    saved: Vec<SavedSegment>,
    replaces_every_segment: bool,
    merged: Vec<WindowMerge>,
}

struct PartitionPlan<'a> {
    partition_id: u32,
    snapshot: &'a PartitionSnapshot,
    prior: Option<&'a PartitionEntry>,
    rewrites_every_segment: bool,
    unchanged: bool,
    compaction_threshold: usize,
    pages_text: bool,
}

fn write_partition(
    writer: &mut CheckpointTarget<'_>,
    index: &IndexState,
    partitions: &[Arc<Partition>],
    plan: PartitionPlan<'_>,
    budget: &mut RewriteBudget,
) -> Result<(PartitionEntry, PartitionSwap)> {
    let PartitionPlan {
        partition_id,
        snapshot,
        prior,
        rewrites_every_segment,
        unchanged,
        compaction_threshold,
        pages_text,
    } = plan;
    let mut segments = SegmentWriter {
        writer,
        index_name: &index.name,
        partition_id,
        pages_text,
    };
    let mut next_id = snapshot
        .next_segment_id
        .max(prior.map_or(0, |entry| entry.next_segment_id));
    let mut swap = PartitionSwap {
        saved: Vec::new(),
        replaces_every_segment: rewrites_every_segment,
        merged: Vec::new(),
    };
    if rewrites_every_segment {
        let (entry, saved) = segments.rewrite_partition(snapshot, &index.schema, next_id)?;
        swap.saved.extend(saved);
        return Ok((entry, swap));
    }
    let listed_before = prior
        .filter(|_| unchanged)
        .and_then(|entry| listed_as_before(entry, snapshot));
    let mut listed = match listed_before {
        Some(listed) => listed,
        None => listed_with_changes(
            &mut segments,
            index,
            partitions,
            snapshot,
            prior,
            &mut next_id,
            &mut swap.saved,
        )?,
    };
    if let Some(window) = choose_window(&listed, compaction_threshold, pages_text) {
        let merged = merge_window(
            &mut segments,
            index,
            partitions,
            &mut listed,
            window,
            next_id,
        )?;
        next_id += 1;
        swap.merged.push(merged);
    }
    let rewrites = rewrite_removed_documents(
        &mut segments,
        index,
        partitions,
        &mut listed,
        &mut next_id,
        budget,
    )?;
    swap.merged.extend(rewrites);
    swap.saved.retain(|saved| {
        swap.merged
            .iter()
            .all(|merged| !merged.replaced.contains(&saved.id))
    });
    let entry = PartitionEntry {
        partition_id,
        next_segment_id: next_id,
        segments: listed.into_iter().map(|listed| listed.reference).collect(),
    };
    Ok((entry, swap))
}

fn apply_swap(partition: &Partition, swap: PartitionSwap) {
    partition.write(|snapshot| {
        let max_id = swap
            .saved
            .iter()
            .chain(
                swap.merged
                    .iter()
                    .filter_map(|merged| merged.saved.as_ref()),
            )
            .map(|saved| saved.id + 1)
            .max()
            .unwrap_or(0);
        snapshot.next_segment_id = snapshot.next_segment_id.max(max_id);
        for merged in swap.merged {
            let first = snapshot
                .segments
                .iter()
                .position(|entry| merged.replaced.contains(&entry.id));
            snapshot
                .segments
                .retain(|entry| !merged.replaced.contains(&entry.id));
            if let (Some(at), Some(saved)) = (first, merged.saved) {
                let at = at.min(snapshot.segments.len());
                snapshot.segments.insert(
                    at,
                    SegmentEntry::new(saved.id, SegmentData::Frozen(saved.frozen)),
                );
            }
        }
        if swap.replaces_every_segment {
            snapshot.segments = swap
                .saved
                .into_iter()
                .map(|saved| SegmentEntry::new(saved.id, SegmentData::Frozen(saved.frozen)))
                .collect();
            return;
        }
        for saved in swap.saved {
            if let Some(entry) = snapshot
                .segments
                .iter_mut()
                .find(|entry| entry.id == saved.id)
            {
                *entry = SegmentEntry::new(saved.id, SegmentData::Frozen(saved.frozen));
            }
        }
    });
}

/// What one checkpoint wrote: the manifest and metadata to commit, and the in-memory changes that apply once the
/// commit succeeds.
pub(super) struct BuiltCheckpoint {
    pub(super) manifest: SegmentManifest,
    pub(super) metadata: IndexMetadata,
    pub(super) saved: SavedSize,
    swaps: Vec<PartitionSwap>,
    written_fields: Vec<WrittenField>,
}

impl BuiltCheckpoint {
    /// Points each paged segment that the checkpoint wrote at its committed file in `backing`, once the commit
    /// succeeds, so that the index keeps only the segment's resident sections in memory.
    pub(super) fn read_paged_from(&mut self, backing: &Backing) {
        for swap in &mut self.swaps {
            for saved in &mut swap.saved {
                saved.read_from_file(backing);
            }
            for saved in swap
                .merged
                .iter_mut()
                .filter_map(|merged| merged.saved.as_mut())
            {
                saved.read_from_file(backing);
            }
        }
    }

    /// Moves each vector field of `index` onto the files that the checkpoint wrote into `backing`, once the
    /// manifest that lists them is durable, and returns the paths of the earlier vector files that a field still
    /// reads.
    pub(super) fn adopt_vectors(&self, backing: &Backing, index: &IndexState) -> HashSet<PathBuf> {
        for field in &self.written_fields {
            field.adopt(backing);
        }
        vector_files_still_read(index)
    }

    /// Replaces each written segment's in-memory form with the frozen form that the checkpoint wrote, once the
    /// files belong to the index's own store.
    pub(super) fn apply(self, partitions: &[Arc<Partition>]) {
        for (partition, swap) in partitions.iter().zip(self.swaps) {
            apply_swap(partition, swap);
        }
    }
}

/// The inputs of one checkpoint beside the index and the target that receives its files.
pub(super) struct CheckpointPlan<'a> {
    pub(super) applied: &'a BTreeMap<u32, u64>,
    pub(super) metadata: IndexMetadata,
    pub(super) limits: CheckpointLimits,
    pub(super) upgraded: Option<&'a SegmentManifest>,
}

/// Writes every file of a checkpoint of `index` into `writer` and returns the manifest that lists them, leaving
/// the index as it stands, while the caller holds the index's write lock.
pub(super) fn build_checkpoint(
    writer: &mut CheckpointTarget<'_>,
    index: &IndexState,
    partitions: &[Arc<Partition>],
    plan: CheckpointPlan<'_>,
) -> Result<BuiltCheckpoint> {
    let rewrites_every_segment = plan.upgraded.is_some();
    let prior = plan.upgraded.cloned().or_else(|| writer.prior().cloned());
    let threshold = plan.limits.compaction_threshold as usize;
    let pages_text = matches!(writer, CheckpointTarget::Log(_))
        && index.config().text_storage == Some(Storage::Disk);
    let mut entries = Vec::with_capacity(partitions.len());
    let mut swaps = Vec::with_capacity(partitions.len());
    let mut budget = RewriteBudget::new(plan.limits.rewrite_bytes_per_checkpoint);
    let checkpoint = partition_checkpoints(writer, plan.applied, partitions.len())?;
    for (at, partition) in partitions.iter().enumerate() {
        let partition_id = at as u32;
        let snapshot = partition.snapshot();
        let prior_entry = prior.as_ref().and_then(|manifest| {
            manifest
                .partitions
                .iter()
                .find(|entry| entry.partition_id == partition_id)
        });
        let partition_plan = PartitionPlan {
            partition_id,
            snapshot: &snapshot,
            prior: prior_entry,
            rewrites_every_segment,
            unchanged: unchanged_since(prior.as_ref(), checkpoint.get(at)),
            compaction_threshold: threshold,
            pages_text,
        };
        let (entry, swap) =
            write_partition(writer, index, partitions, partition_plan, &mut budget)?;
        entries.push(entry);
        swaps.push(swap);
    }
    let prior_vectors = prior
        .as_ref()
        .map_or(&[][..], |manifest| manifest.vectors.as_slice());
    let (vectors, written_fields) =
        write_vector_fields(writer, index, prior_vectors, rewrites_every_segment)?;
    let mut metadata = plan.metadata;
    let manifest = SegmentManifest {
        schema: index
            .config()
            .schema
            .as_object()
            .map(flatten_schema)
            .unwrap_or_default(),
        language: metadata.language.clone(),
        analysis_generation: metadata.analysis_generation,
        checkpoint,
        partitions: entries,
        vectors,
    };
    let saved = SavedSize::of(&manifest);
    metadata.saved_bytes = Some(saved.bytes);
    Ok(BuiltCheckpoint {
        manifest,
        metadata,
        saved,
        swaps,
        written_fields,
    })
}

/// Writes a checkpoint of `index` and commits its manifest, so that recovery starts from it and replays only the
/// log records that follow it.
///
/// An `upgraded` manifest stands in for the previous one while the checkpoint replaces an earlier release's
/// layout: every partition then goes into one new segment, and the checkpoint keeps the vector files it lists.
/// The checkpoint holds the index's write lock from start to commit, so that the files it writes and the log
/// position it records describe the same moment.
pub(crate) fn write_checkpoint(
    index: &IndexState,
    log: &IndexLog,
    upgraded: Option<&SegmentManifest>,
) -> Result<()> {
    let _writer = index.lock_writes()?;
    write_checkpoint_locked(index, log, upgraded)
}

/// Writes a checkpoint of `index` while the caller holds the index's write lock.
pub(super) fn write_checkpoint_locked(
    index: &IndexState,
    log: &IndexLog,
    upgraded: Option<&SegmentManifest>,
) -> Result<()> {
    let mut writer = log.backing().begin_checkpoint(&index.name)?;
    let partitions = index.partitions();
    let applied = log.applied_seq_nos();
    let plan = CheckpointPlan {
        applied: &applied,
        metadata: log.metadata(index),
        limits: log.limits(),
        upgraded,
    };
    let mut built = build_checkpoint(&mut writer, index, &partitions, plan)?;
    let backing = log.backing();
    writer.commit(&built.manifest, &built.metadata, &mut || {
        built.adopt_vectors(backing, index)
    })?;
    built.read_paged_from(backing);
    log.remember(built.metadata.clone());
    log.record_saved(built.saved.clone());
    log.checkpointed();
    built.apply(&partitions);
    Ok(())
}
