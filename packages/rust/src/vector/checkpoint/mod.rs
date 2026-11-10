pub(crate) mod files;

use std::sync::Arc;

use crate::config::MAX_DOC_ID_LENGTH;
use crate::error::Result;
use crate::format::envelope::MAX_FILE_BYTES;
use crate::format::graph_part::{GraphPart, VECTOR_GRAPH_PART_VECTORS};
use crate::format::vector_file::{VECTOR_FILE_MAX_VECTORS, osq_record_bytes};

use super::constants::{
    MAX_DOC_ID_UTF8_BYTES_PER_UNIT, VECTOR_FILE_CENTROID_BYTES_PER_COMPONENT,
    VECTOR_FILE_FIXED_OVERHEAD_BYTES, VECTOR_FILE_REPLACED_ABOVE_DEAD_SHARE,
    VECTOR_FILE_STRING_HEADER_BYTES,
};
use super::field::{Generation, Shared, VectorField, Writer};
use super::numbered::{NO_ORDINAL, Numbering, serialise_parts, without_nodes};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SavedVectorFile {
    pub(crate) id: u64,
    pub(crate) key: String,
    pub(crate) ordinals: Vec<i32>,
    pub(crate) calibration: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct FieldSignature {
    pub(crate) revision: u64,
    pub(crate) graph_size: i64,
    pub(crate) calibration: Option<i32>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct KeptVectorFile {
    pub(crate) id: u64,
    pub(crate) key: String,
    pub(crate) count: usize,
    pub(crate) dead: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WrittenVectorFile {
    pub(crate) id: u64,
    pub(crate) key: String,
    pub(crate) ordinals: Vec<i32>,
}

struct PlannedVector {
    ordinal: u32,
    doc_id: String,
    tombstoned: bool,
}

pub(crate) struct VectorCheckpointPlan {
    pub(crate) unchanged: bool,
    pub(crate) kept: Vec<KeptVectorFile>,
    pub(crate) new_files: usize,
    pub(crate) signature: FieldSignature,
    pub(crate) stores_heads: bool,
    kept_files: Vec<SavedVectorFile>,
    generation: Arc<Generation>,
    field_name: String,
    metric: u32,
    planned: Vec<PlannedVector>,
    centroid: Option<Vec<f32>>,
    capacity: usize,
    first_written_number: usize,
    graph_parts: Option<Vec<GraphPart>>,
    vanished: Vec<bool>,
}

pub(crate) fn vectors_per_file(dimension: usize, bits: u8) -> usize {
    let record_bytes = if matches!(bits, 1 | 2 | 4 | 8) {
        osq_record_bytes(dimension, bits) as u64
    } else {
        0
    };
    let doc_id_bytes =
        VECTOR_FILE_STRING_HEADER_BYTES + MAX_DOC_ID_LENGTH as u64 * MAX_DOC_ID_UTF8_BYTES_PER_UNIT;
    let per_vector = dimension as u64 * 4 + record_bytes + doc_id_bytes;
    let overhead = VECTOR_FILE_FIXED_OVERHEAD_BYTES
        + dimension as u64 * VECTOR_FILE_CENTROID_BYTES_PER_COMPONENT;
    let fitting = MAX_FILE_BYTES.saturating_sub(overhead) / per_vector.max(1);
    (fitting as usize).clamp(1, VECTOR_FILE_MAX_VECTORS)
}

fn is_live(generation: &Generation, ordinal: i32) -> bool {
    u32::try_from(ordinal).is_ok_and(|found| generation.store.is_live(found))
}

fn is_graph_tombstone(generation: &Generation, ordinal: i32) -> bool {
    let Ok(found) = u32::try_from(ordinal) else {
        return false;
    };
    generation
        .graph
        .as_ref()
        .is_some_and(|graph| graph.holds_tombstone(found))
}

fn is_carried(generation: &Generation, ordinal: i32) -> bool {
    is_live(generation, ordinal) || is_graph_tombstone(generation, ordinal)
}

fn dead_bits_where(count: usize, is_dead_at: impl Fn(usize) -> bool) -> Option<Vec<u8>> {
    let mut dead: Option<Vec<u8>> = None;
    for position in 0..count {
        if !is_dead_at(position) {
            continue;
        }
        let bits = dead.get_or_insert_with(|| vec![0u8; count.div_ceil(8)]);
        bits[position >> 3] |= 1 << (position & 7);
    }
    dead
}

fn coded_centroid(shared: &Shared, generation: &Generation) -> Option<Vec<f32>> {
    let store = &generation.store;
    (shared.settings.bits() != 0 && store.calibrated() && generation.graph.is_some())
        .then(|| store.centroid())
}

pub(crate) fn signature_of(shared: &Shared, writer: &Writer) -> FieldSignature {
    let generation = &writer.generation;
    FieldSignature {
        revision: writer.revision,
        graph_size: generation
            .graph
            .as_ref()
            .map_or(-1, |graph| graph.size() as i64),
        calibration: coded_centroid(shared, generation)
            .map(|_| generation.store.calibration_generation()),
    }
}

fn files_worth_keeping(
    generation: &Generation,
    listed: &[SavedVectorFile],
    calibration: Option<i32>,
    carried_counts: &mut Vec<usize>,
) -> Vec<SavedVectorFile> {
    let mut kept = Vec::new();
    for file in listed {
        let carried = file
            .ordinals
            .iter()
            .filter(|&&ordinal| is_carried(generation, ordinal))
            .count();
        let dead_share = if file.ordinals.is_empty() {
            1.0
        } else {
            1.0 - carried as f64 / file.ordinals.len() as f64
        };
        if file.calibration != calibration || dead_share > VECTOR_FILE_REPLACED_ABOVE_DEAD_SHARE {
            continue;
        }
        kept.push(file.clone());
        carried_counts.push(carried);
    }
    kept
}

fn absorb_smaller_partial_files(
    kept: &mut Vec<SavedVectorFile>,
    carried_counts: &mut Vec<usize>,
    to_write: usize,
    capacity: usize,
) {
    let mut pending = to_write;
    let mut index = kept.len();
    while index > 0 && pending > 0 {
        index -= 1;
        if kept[index].ordinals.len() >= capacity {
            continue;
        }
        if carried_counts[index] > pending {
            return;
        }
        pending += carried_counts[index];
        kept.remove(index);
        carried_counts.remove(index);
    }
}

fn count_outside(generation: &Generation, carried_counts: &[usize]) -> usize {
    let counts = &generation.counts;
    let held: u64 = carried_counts.iter().map(|&count| count as u64).sum();
    let tombstoned_nodes = generation
        .graph
        .as_ref()
        .map_or(0, |graph| graph.tombstone_count());
    (counts.live() + tombstoned_nodes).saturating_sub(held) as usize
}

fn ordinals_outside(generation: &Generation, kept: &[SavedVectorFile]) -> Vec<u32> {
    let slots = generation.store.slots();
    let mut saved = vec![false; slots as usize];
    for ordinal in kept.iter().flat_map(|file| file.ordinals.iter()) {
        if let Ok(found) = usize::try_from(*ordinal)
            && found < saved.len()
        {
            saved[found] = true;
        }
    }
    (0..slots)
        .filter(|&ordinal| !saved[ordinal as usize] && is_carried(generation, ordinal as i32))
        .collect()
}

fn graph_parts_of(
    shared: &Shared,
    writer: &Writer,
    kept: &[SavedVectorFile],
    written: &[u32],
) -> Option<Vec<GraphPart>> {
    let generation = &writer.generation;
    let graph = generation.graph.as_ref()?;
    let total = kept.iter().map(|file| file.ordinals.len()).sum::<usize>() + written.len();
    if total == 0 {
        return None;
    }
    let mut number_of_ordinal = vec![NO_ORDINAL; generation.store.slots() as usize];
    let mut ordinal_of_number = vec![NO_ORDINAL; total];
    let mut number = 0usize;
    for file in kept {
        for &ordinal in &file.ordinals {
            if is_carried(generation, ordinal)
                && let Some(slot) = number_of_ordinal.get_mut(ordinal as usize)
            {
                *slot = number as i32;
                ordinal_of_number[number] = ordinal;
            }
            number += 1;
        }
    }
    for &ordinal in written {
        number_of_ordinal[ordinal as usize] = number as i32;
        ordinal_of_number[number] = ordinal as i32;
        number += 1;
    }
    let numbering = Numbering {
        number_of_ordinal: &number_of_ordinal,
        ordinal_of_number: &ordinal_of_number,
    };
    let shuffled = shared.history.shuffled_build_count();
    let parts = serialise_parts(graph, &numbering, VECTOR_GRAPH_PART_VECTORS);
    Some(
        parts
            .into_iter()
            .map(|mut part| {
                if let Some(count) = shuffled {
                    part.shuffled_build_count = Some(count.min(u64::from(u32::MAX)) as u32);
                    part.calibrated_mean_length = writer.calibrated_mean_length;
                }
                GraphPart {
                    field_name: shared.settings.field_name.clone(),
                    graphs: vec![part],
                }
            })
            .collect(),
    )
}

impl VectorField {
    pub(crate) fn plan_checkpoint(
        &self,
        listed_keys: Option<&[String]>,
        rewrites_graph: bool,
    ) -> Result<VectorCheckpointPlan> {
        let shared = &self.shared;
        let writer = shared.lock_writer();
        let generation = Arc::clone(&writer.generation);
        let signature = signature_of(shared, &writer);
        let listed = listed_keys.unwrap_or(&[]);
        let trusted = listed.len() == writer.saved_files.len()
            && writer
                .saved_files
                .iter()
                .zip(listed)
                .all(|(file, key)| &file.key == key);
        let capacity = vectors_per_file(shared.settings.dimension, shared.settings.bits());
        let mut carried_counts = Vec::new();
        let mut kept_files = if trusted {
            files_worth_keeping(
                &generation,
                &writer.saved_files,
                signature.calibration,
                &mut carried_counts,
            )
        } else {
            Vec::new()
        };
        let outside = count_outside(&generation, &carried_counts);
        absorb_smaller_partial_files(&mut kept_files, &mut carried_counts, outside, capacity);
        let written = ordinals_outside(&generation, &kept_files);
        let unchanged = !rewrites_graph
            && trusted
            && listed_keys.is_some()
            && writer.saved_signature == Some(signature)
            && written.is_empty();
        let first_written_number = kept_files.iter().map(|file| file.ordinals.len()).sum();
        let graph_parts = if unchanged {
            None
        } else {
            graph_parts_of(shared, &writer, &kept_files, &written)
        };
        let planned = written
            .iter()
            .map(|&ordinal| PlannedVector {
                ordinal,
                doc_id: generation.doc_id(ordinal).unwrap_or("").to_string(),
                tombstoned: !generation.store.is_live(ordinal),
            })
            .collect::<Vec<_>>();
        let kept = kept_files
            .iter()
            .map(|file| KeptVectorFile {
                id: file.id,
                key: file.key.clone(),
                count: file.ordinals.len(),
                dead: dead_bits_where(file.ordinals.len(), |position| {
                    !is_live(&generation, file.ordinals[position])
                }),
            })
            .collect();
        Ok(VectorCheckpointPlan {
            unchanged,
            kept,
            new_files: planned.len().div_ceil(capacity),
            signature,
            stores_heads: shared.settings.reads_from_disk(),
            kept_files,
            centroid: coded_centroid(shared, &generation),
            field_name: shared.settings.field_name.clone(),
            metric: shared.settings.metric_code(),
            generation,
            planned,
            capacity,
            first_written_number,
            graph_parts,
            vanished: Vec::new(),
        })
    }

    pub(crate) fn record_checkpoint(
        &self,
        plan: &VectorCheckpointPlan,
        written: &[WrittenVectorFile],
    ) {
        if plan.unchanged {
            return;
        }
        let mut writer = self.shared.lock_writer();
        let calibration = plan.signature.calibration;
        let mut saved = plan.kept_files.clone();
        saved.extend(written.iter().map(|file| SavedVectorFile {
            id: file.id,
            key: file.key.clone(),
            ordinals: file.ordinals.clone(),
            calibration,
        }));
        writer.saved_files = saved;
        writer.saved_signature = Some(plan.signature);
    }
}

impl VectorCheckpointPlan {
    pub(crate) fn graph_parts(&self) -> Option<Vec<GraphPart>> {
        let parts = self.graph_parts.as_ref()?;
        if !self.vanished.contains(&true) {
            return Some(parts.clone());
        }
        Some(
            parts
                .iter()
                .enumerate()
                .map(|(index, part)| GraphPart {
                    field_name: part.field_name.clone(),
                    graphs: part
                        .graphs
                        .iter()
                        .map(|graph| {
                            without_nodes(graph, index * VECTOR_GRAPH_PART_VECTORS, &self.vanished)
                        })
                        .collect(),
                })
                .collect(),
        )
    }
}
