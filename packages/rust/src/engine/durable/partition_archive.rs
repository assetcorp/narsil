use std::collections::HashSet;
use std::sync::Arc;

use super::archive::{ArchiveCheckpoint, current_metadata, encoded_configuration};
use super::backing::CheckpointTarget;
use super::checkpoint_segments::SegmentWriter;
use crate::durability::persistence::MemoryPersistence;
use crate::durability::snapshot_only::SnapshotStore;
use crate::engine::index::IndexState;
use crate::engine::replication::CopyPosition;
use crate::engine::replication::copy_state::{ReplicatedCopy, no_such_partition};
use crate::error::Result;
use crate::format::envelope::{Compression, MAX_FILE_BYTES, pack};
use crate::format::layout::vector_file_key;
use crate::format::manifest::SegmentManifest;
use crate::format::manifest_refs::{VectorFieldRef, VectorFileRef};
use crate::format::vector_file::{
    VECTOR_FILE_ENVELOPE_VERSION, VECTOR_FILE_MAX_VECTORS, VectorFile, encode_vector_file,
};
use crate::index::partition::PartitionSnapshot;
use crate::schema::flatten_schema;
use crate::vector::field::VectorField;

const FLOAT32_BYTES: u64 = 4;
const VECTOR_FILE_ROOM_PER_VECTOR_BYTES: u64 = 1_024;

/// The archive of one partition of a cluster copy: the index configuration, a checkpoint that lists that
/// partition alone, and the position of the copy that the checkpoint holds.
pub(crate) struct PartitionArchive {
    pub(crate) config: Vec<u8>,
    pub(crate) checkpoint: ArchiveCheckpoint,
    pub(crate) position: CopyPosition,
}

fn live_ids(snapshot: &PartitionSnapshot) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    for entry in &snapshot.segments {
        for ordinal in entry.live_ordinals() {
            ids.push(entry.id_of(ordinal)?.into_owned());
        }
    }
    Ok(ids)
}

fn vectors_per_file(dimension: usize) -> usize {
    let per_vector = dimension as u64 * FLOAT32_BYTES + VECTOR_FILE_ROOM_PER_VECTOR_BYTES;
    let fitting = (MAX_FILE_BYTES / per_vector.max(1)) as usize;
    fitting.clamp(1, VECTOR_FILE_MAX_VECTORS)
}

struct FieldFiles<'t, 'a> {
    target: &'t mut CheckpointTarget<'a>,
    index_name: &'t str,
    path: &'t str,
    files: Vec<VectorFileRef>,
}

impl FieldFiles<'_, '_> {
    fn write(&mut self, dimension: usize, doc_ids: Vec<String>, vectors: Vec<f32>) -> Result<()> {
        if doc_ids.is_empty() {
            return Ok(());
        }
        let id = self.files.len() as u64;
        let key = vector_file_key(self.index_name, self.path, id)?;
        let count = u32::try_from(doc_ids.len()).unwrap_or(u32::MAX);
        let file = VectorFile {
            field_name: self.path.to_string(),
            dimension,
            doc_ids,
            codes: None,
            vectors,
            disk: None,
        };
        let (payload, head) = encode_vector_file(&file)?;
        let packed = pack(
            &payload,
            VECTOR_FILE_ENVELOPE_VERSION,
            Compression::None,
            "vector file",
        )?;
        let mut written = self.target.write_file(&key, &packed)?;
        written.head = head;
        self.files.push(VectorFileRef {
            id,
            file: written,
            count,
            dead: None,
        });
        Ok(())
    }
}

fn write_field_vectors(
    target: &mut CheckpointTarget<'_>,
    index_name: &str,
    path: &str,
    field: &VectorField,
    ids: &[String],
) -> Result<VectorFieldRef> {
    let dimension = field.dimension();
    let per_file = vectors_per_file(dimension);
    let mut files = FieldFiles {
        target,
        index_name,
        path,
        files: Vec::new(),
    };
    let mut doc_ids = Vec::new();
    let mut vectors = Vec::new();
    for id in ids {
        let Some(vector) = field.get_vector(id)? else {
            continue;
        };
        doc_ids.push(id.clone());
        vectors.extend_from_slice(&vector);
        if doc_ids.len() == per_file {
            files.write(
                dimension,
                std::mem::take(&mut doc_ids),
                std::mem::take(&mut vectors),
            )?;
        }
    }
    files.write(dimension, doc_ids, vectors)?;
    Ok(VectorFieldRef {
        field_path: path.to_string(),
        next_file_id: files.files.len() as u64,
        files: files.files,
        graph_generation: 0,
        graph_parts: Vec::new(),
    })
}

/// Writes the archive files of `partition` of the cluster copy `index` into memory while it holds the index's
/// write lock, so that the segments, the write records, the term history, and the vectors all describe the copy at
/// the position that it returns. The manifest lists that partition alone and no graph part, and each vector file
/// holds the vectors of that partition's documents alone.
pub(crate) fn partition_archive(
    index: &IndexState,
    copy: &ReplicatedCopy,
    partition: u32,
) -> Result<PartitionArchive> {
    let store = SnapshotStore::open(Arc::new(MemoryPersistence::new()))?;
    let writer = index.lock_writes()?;
    let position = {
        let held = copy.partition(&index.name, partition)?;
        if let Some(failure) = &held.failure {
            return Err(failure.clone());
        }
        held.position
    };
    let covered = copy
        .checkpointed(partition, 0)
        .ok_or_else(|| no_such_partition(&index.name, partition))?;
    let metadata = current_metadata(index);
    let config = encoded_configuration(index, &metadata)?;
    let partitions = index.partitions();
    let snapshot = partitions
        .get(partition as usize)
        .ok_or_else(|| no_such_partition(&index.name, partition))?
        .snapshot();
    let mut target = CheckpointTarget::Snapshot(store.begin_checkpoint(&index.name)?);
    let (entry, _) = SegmentWriter {
        writer: &mut target,
        index_name: &index.name,
        partition_id: partition,
        pages_text: false,
        copy: Some(copy),
        snapshot: &snapshot,
    }
    .rewrite_partition(&snapshot, &index.schema, 0)?;
    let ids = live_ids(&snapshot)?;
    let mut vectors = Vec::new();
    for field in index.vectors.fields() {
        vectors.push(write_field_vectors(
            &mut target,
            &index.name,
            &field.path,
            &field.field,
            &ids,
        )?);
    }
    let manifest = SegmentManifest {
        schema: index
            .config()
            .schema
            .as_object()
            .map(flatten_schema)
            .unwrap_or_default(),
        language: metadata.language.clone(),
        analysis_generation: metadata.analysis_generation,
        checkpoint: vec![covered],
        partitions: vec![entry],
        vectors,
    };
    target.commit(&manifest, &metadata, &mut HashSet::new)?;
    drop(writer);
    Ok(PartitionArchive {
        config,
        checkpoint: ArchiveCheckpoint::in_memory(store, &index.name)?,
        position,
    })
}
