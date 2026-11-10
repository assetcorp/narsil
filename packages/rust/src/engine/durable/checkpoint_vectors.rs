use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use super::backing::{Backing, CheckpointTarget};
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{Compression, pack};
use crate::format::graph_part::{GRAPH_PART_ENVELOPE_VERSION, encode_graph_part};
use crate::format::layout::{graph_part_key, vector_file_key};
use crate::format::manifest_refs::{FileRef, VectorFieldRef, VectorFileRef};
use crate::format::vector_file::{VECTOR_FILE_ENVELOPE_VERSION, encode_vector_file};
use crate::vector::checkpoint::{VectorCheckpointPlan, WrittenVectorFile};
use crate::vector::disk::VectorFileLayout;
use crate::vector::field::VectorField;

/// Where the vectors of one written file start, and which of its entries hold no live vector.
struct WrittenLayout {
    vectors_offset: u64,
    dead: Option<Vec<u8>>,
}

/// The vector files that a checkpoint wrote for one field, which the field records once the checkpoint commits.
pub(crate) struct WrittenField {
    field: Arc<VectorField>,
    plan: VectorCheckpointPlan,
    files: Vec<WrittenVectorFile>,
    layouts: Vec<WrittenLayout>,
}

impl WrittenField {
    /// Records the files that the checkpoint wrote, then points each vector of a field that keeps its vectors on
    /// disk at its place in those files, so that the field frees the memory that held it.
    ///
    /// A file that the field fails to map leaves its vectors in memory, where they answer searches as before.
    pub(crate) fn adopt(&self, backing: &Backing) {
        self.field.record_checkpoint(&self.plan, &self.files);
        for (file, layout) in self.files.iter().zip(&self.layouts) {
            let Ok(Some(path)) = backing.path_of(&file.key) else {
                continue;
            };
            let _ = self.field.adopt_disk_layout(&VectorFileLayout {
                path: &path,
                vectors_offset: layout.vectors_offset,
                ordinals: &file.ordinals,
                dead: layout.dead.as_deref(),
            });
        }
    }
}

/// Returns the paths of the vector files that a field of `index` still reads its vectors from.
pub(crate) fn vector_files_still_read(index: &IndexState) -> HashSet<PathBuf> {
    index
        .vectors
        .fields()
        .iter()
        .flat_map(|entry| entry.field.vector_files_in_use())
        .collect()
}

fn kept_file_ref(prior: Option<&VectorFieldRef>, key: &str) -> Result<FileRef> {
    prior
        .and_then(|listed| listed.files.iter().find(|file| file.file.key == key))
        .map(|file| file.file.clone())
        .ok_or_else(|| {
            NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!(
                    "The checkpoint keeps the vector file \"{key}\", which the previous manifest does not list"
                ),
            )
        })
}

struct FieldTarget<'a> {
    index_name: &'a str,
    path: &'a str,
    field: &'a Arc<VectorField>,
    prior: Option<&'a VectorFieldRef>,
    rewrites_graph: bool,
}

fn write_field(
    writer: &mut CheckpointTarget<'_>,
    target: FieldTarget<'_>,
) -> Result<(VectorFieldRef, Option<WrittenField>)> {
    let FieldTarget {
        index_name,
        path,
        field,
        prior,
        rewrites_graph,
    } = target;
    let listed: Option<Vec<String>> = prior.map(|listed| {
        listed
            .files
            .iter()
            .map(|file| file.file.key.clone())
            .collect()
    });
    let mut plan = field.plan_checkpoint(listed.as_deref(), rewrites_graph)?;
    if plan.unchanged
        && let Some(prior) = prior
    {
        return Ok((prior.clone(), None));
    }
    let mut next_file_id = prior.map_or(0, |listed| listed.next_file_id);
    let mut files = Vec::with_capacity(plan.kept.len() + plan.new_files);
    for kept in &plan.kept {
        files.push(VectorFileRef {
            id: kept.id,
            file: kept_file_ref(prior, &kept.key)?,
            count: u32::try_from(kept.count).unwrap_or(u32::MAX),
            dead: kept.dead.clone(),
        });
    }
    let mut written = Vec::with_capacity(plan.new_files);
    let mut layouts = Vec::with_capacity(plan.new_files);
    for at in 0..plan.new_files {
        let new = plan.read_new_file(at)?;
        let id = next_file_id;
        next_file_id += 1;
        let key = vector_file_key(index_name, path, id)?;
        let (payload, head) = encode_vector_file(&new.file)?;
        let packed = pack(
            &payload,
            VECTOR_FILE_ENVELOPE_VERSION,
            Compression::None,
            "vector file",
        )?;
        let mut file = writer.write_file(&key, &packed)?;
        file.head = head;
        let vector_bytes = (new.file.vectors.len() as u64).saturating_mul(4);
        layouts.push(WrittenLayout {
            vectors_offset: (packed.len() as u64).saturating_sub(vector_bytes),
            dead: new.dead.clone(),
        });
        files.push(VectorFileRef {
            id,
            file,
            count: u32::try_from(new.file.doc_ids.len()).unwrap_or(u32::MAX),
            dead: new.dead,
        });
        written.push(WrittenVectorFile {
            id,
            key,
            ordinals: new.ordinals,
        });
    }
    let parts = plan.graph_parts().unwrap_or_default();
    let prior_generation = prior.map_or(0, |listed| listed.graph_generation);
    let graph_generation = if parts.is_empty() {
        prior_generation
    } else {
        prior_generation + 1
    };
    let mut graph_parts = Vec::with_capacity(parts.len());
    for (at, part) in parts.iter().enumerate() {
        let key = graph_part_key(index_name, path, graph_generation, at as u64)?;
        let (payload, head) = encode_graph_part(part, plan.stores_heads)?;
        let packed = pack(
            &payload,
            GRAPH_PART_ENVELOPE_VERSION,
            Compression::None,
            "graph part",
        )?;
        let mut file = writer.write_file(&key, &packed)?;
        file.head = head;
        graph_parts.push(file);
    }
    let reference = VectorFieldRef {
        field_path: path.to_string(),
        next_file_id,
        files,
        graph_generation,
        graph_parts,
    };
    let recorded = WrittenField {
        field: Arc::clone(field),
        plan,
        files: written,
        layouts,
    };
    Ok((reference, Some(recorded)))
}

/// Writes the vector files and graph parts of every vector field that changed since `prior`, keeping each file
/// that an earlier checkpoint wrote and that the field still holds unchanged. With `rewrites_graph`, as an
/// upgrade from an earlier release's layout needs, every field writes its graph again.
pub(crate) fn write_vector_fields(
    writer: &mut CheckpointTarget<'_>,
    index: &IndexState,
    prior: &[VectorFieldRef],
    rewrites_graph: bool,
) -> Result<(Vec<VectorFieldRef>, Vec<WrittenField>)> {
    let mut references = Vec::new();
    let mut written = Vec::new();
    for entry in index.vectors.fields() {
        let listed = prior.iter().find(|field| field.field_path == entry.path);
        let target = FieldTarget {
            index_name: &index.name,
            path: &entry.path,
            field: &entry.field,
            prior: listed,
            rewrites_graph,
        };
        let (reference, recorded) = write_field(writer, target)?;
        references.push(reference);
        written.extend(recorded);
    }
    Ok((references, written))
}
