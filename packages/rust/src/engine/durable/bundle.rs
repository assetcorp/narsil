use super::load::{grow_partitions, load_failed};
use crate::config::MAX_PARTITIONS;
use crate::engine::index::IndexState;
use crate::engine::writes::place_document;
use crate::error::Result;
use crate::format::earlier_payload::{
    EarlierVectorField, decode_snapshot_bundle, decode_v2_documents,
};
use crate::format::manifest::{PartitionCheckpoint, SegmentManifest};
use crate::format::vector_file::VectorFile;
use crate::vector::restore::{CheckpointRestoreShape, LoadedVectorFile};

/// What a snapshot bundle held: the log position that it covers, and the empty manifest that the upgrade
/// checkpoint starts from.
pub(crate) struct BundleLoaded {
    pub(crate) checkpoint: Vec<PartitionCheckpoint>,
    pub(crate) prior: SegmentManifest,
}

fn bundle_part_key(field_path: &str, at: usize) -> String {
    format!("snapshot-bundle/{field_path}/{at}")
}

fn restore_field(index: &IndexState, field_path: &str, stored: EarlierVectorField) -> Result<()> {
    let Some(field) = index.vectors.field(field_path) else {
        return Ok(());
    };
    let live_vectors = stored
        .parts
        .iter()
        .map(|part| part.doc_ids.len() as u64)
        .sum();
    let mut restore = field.begin_restore(CheckpointRestoreShape {
        live_vectors,
        holds_graph: stored.graph.is_some(),
        graph: stored.graph,
    });
    for (at, part) in stored.parts.into_iter().enumerate() {
        restore.add_file(LoadedVectorFile {
            id: at as u64,
            key: bundle_part_key(field_path, at),
            file: VectorFile {
                field_name: part.field_name,
                dimension: part.dimension,
                doc_ids: part.doc_ids,
                codes: part.codes,
                vectors: part.vectors,
                disk: None,
            },
            dead: None,
            location: None,
        })?;
    }
    restore.finish()
}

fn fit_partitions(index: &IndexState, count: usize) -> Result<()> {
    if count as u64 > MAX_PARTITIONS {
        return Err(load_failed(format!(
            "Snapshot bundle holds {count} partitions, beyond the {MAX_PARTITIONS} partitions that an index holds at most"
        )));
    }
    if count == 0 {
        return Ok(());
    }
    grow_partitions(index, count, 0..count as u32)?;
    let mut partitions = index.partitions().to_vec();
    if partitions.len() > count {
        partitions.truncate(count);
        index.replace_partitions(partitions);
    }
    Ok(())
}

/// Loads the snapshot bundle that the snapshot tier of engine 0.3.0 saved: each partition's stored documents,
/// indexed again under the index's analysis into the partition that the bundle gives them, then each vector
/// field's parts and graph.
pub(crate) fn load_bundle(index: &IndexState, payload: &[u8]) -> Result<BundleLoaded> {
    let bundle = decode_snapshot_bundle(payload)?;
    fit_partitions(index, bundle.partitions.len())?;
    for (at, bytes) in bundle.partitions.iter().enumerate() {
        let stored = decode_v2_documents(bytes)?;
        for (id, document) in stored.documents {
            place_document(index, at, &id, document)?;
        }
    }
    for (field_path, stored) in bundle.vector_indexes {
        restore_field(index, &field_path, stored)?;
    }
    let prior = SegmentManifest {
        schema: bundle.schema,
        language: bundle.language,
        analysis_generation: None,
        checkpoint: Vec::new(),
        partitions: Vec::new(),
        vectors: Vec::new(),
    };
    Ok(BundleLoaded {
        checkpoint: bundle.checkpoint,
        prior,
    })
}
