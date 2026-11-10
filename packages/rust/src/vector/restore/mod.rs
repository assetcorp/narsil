mod finish;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::graph_part::GraphParts;
use crate::format::vector_file::VectorFile;

use super::disk::is_dead;
use super::field::{Generation, NO_DRIFT_CHECK, Shared, VectorField, Writer};
use super::files::MappedFile;
use super::numbered::{NO_ORDINAL, NumberedParts};
use super::store::{FLAG_CURRENT, FLAG_REPLACED, magnitude_of};
use super::writes::{Held, append, retire_previous};

pub(crate) struct CheckpointRestoreShape {
    pub(crate) live_vectors: u64,
    pub(crate) holds_graph: bool,
    pub(crate) graph: Option<GraphParts>,
}

pub(crate) struct VectorFileLocation {
    pub(crate) path: PathBuf,
    pub(crate) vectors_offset: u64,
}

pub(crate) struct LoadedVectorFile {
    pub(crate) id: u64,
    pub(crate) key: String,
    pub(crate) file: VectorFile,
    pub(crate) dead: Option<Vec<u8>>,
    pub(crate) location: Option<VectorFileLocation>,
}

struct RestoredFile {
    id: u64,
    key: String,
    ordinals: Vec<i32>,
    coded: bool,
}

pub(crate) struct VectorRestore {
    shared: Arc<Shared>,
    graph: Option<GraphParts>,
    cold: bool,
    restores_codes: bool,
    files: Vec<RestoredFile>,
    tombstoned: Vec<u32>,
    next_number: usize,
    centroid: Option<Vec<f64>>,
    codes_agree: bool,
    finished: bool,
}

fn empty_writer(shared: &Shared, writer: &mut Writer) {
    writer.generation = Arc::new(Generation::empty(&shared.settings, shared.hasher.clone()));
    writer.id_slots_used = 0;
    writer.job = None;
    writer.placing = None;
    writer.calibrated_count = None;
    writer.calibrated_mean_length = None;
    writer.removed_ordinals.clear();
    writer.replaced_ordinals.clear();
    writer.saved_files.clear();
    writer.saved_signature = None;
    writer.pending_locations.clear();
    shared.history.set_shuffled_build_count(None);
    shared
        .history
        .next_drift_check_at
        .store(NO_DRIFT_CHECK, Ordering::Release);
    shared
        .history
        .compacted_node_count
        .store(0, Ordering::Release);
}

impl VectorField {
    pub(crate) fn begin_restore(&self, shape: CheckpointRestoreShape) -> VectorRestore {
        let shared = &self.shared;
        shared.restoring.store(true, Ordering::Release);
        let mut writer = shared.lock_writer();
        writer.holds_publication = true;
        empty_writer(shared, &mut writer);
        let settings = &shared.settings;
        let cold = settings.reads_from_disk()
            && (shape.holds_graph || shape.live_vectors >= settings.promotion_threshold);
        VectorRestore {
            shared: Arc::clone(shared),
            graph: shape.graph,
            cold,
            restores_codes: settings.bits() != 0 && shape.holds_graph,
            files: Vec::new(),
            tombstoned: Vec::new(),
            next_number: 0,
            centroid: None,
            codes_agree: true,
            finished: false,
        }
    }
}

impl VectorRestore {
    fn graph_holds_node_for(&self, number: usize) -> bool {
        let Some(graph) = &self.graph else {
            return false;
        };
        let (Some(parts), Some(&part_size)) = (graph.graphs.first(), graph.part_size.first())
        else {
            return false;
        };
        NumberedParts { parts, part_size }.top_layer(number) >= 0
    }

    fn file_index(&self, writer: &mut Writer, location: &VectorFileLocation) -> Result<usize> {
        let generation = Arc::clone(&writer.generation);
        let mut owners = generation.store.files().owners().to_vec();
        if let Some(found) = owners.iter().position(|file| file.path() == location.path) {
            return Ok(found);
        }
        owners.push(MappedFile::open(&location.path)?);
        let index = owners.len() - 1;
        let store = Arc::new(generation.store.with_files(owners));
        self.shared
            .publish(writer, generation.with(|parts| parts.store = store));
        Ok(index)
    }

    pub(crate) fn add_file(&mut self, loaded: LoadedVectorFile) -> Result<()> {
        let shared = Arc::clone(&self.shared);
        let dimension = shared.settings.dimension;
        let file = &loaded.file;
        if file.dimension != dimension {
            return Err(NarsilError::new(
                ErrorCode::VECTOR_DIMENSION_MISMATCH,
                format!(
                    "Payload dimension {} does not match index dimension {dimension}",
                    file.dimension
                ),
            ));
        }
        let mut writer = shared.lock_writer();
        let on_disk = shared.settings.reads_from_disk() && loaded.location.is_some();
        let file_index = match (&loaded.location, on_disk && self.cold) {
            (Some(location), true) => Some(self.file_index(&mut writer, location)?),
            _ => None,
        };
        let mut ordinals = vec![NO_ORDINAL; file.doc_ids.len()];
        let first_number = self.next_number;
        self.next_number += file.doc_ids.len();
        for (at, doc_id) in file.doc_ids.iter().enumerate() {
            let dead = is_dead(loaded.dead.as_deref(), at);
            if dead && !self.graph_holds_node_for(first_number + at) {
                continue;
            }
            let Some(vector) = file.vectors.get(at * dimension..(at + 1) * dimension) else {
                continue;
            };
            let offset = loaded.location.as_ref().map_or(0, |location| {
                location.vectors_offset + (at * dimension * 4) as u64
            });
            let held = match (file_index, u32::try_from(offset)) {
                (Some(index), Ok(offset)) => Held::InFile {
                    magnitude: file
                        .disk
                        .as_ref()
                        .and_then(|disk| disk.magnitudes.get(at).copied())
                        .unwrap_or_else(|| magnitude_of(vector)),
                    file: index,
                    offset,
                },
                _ => Held::InMemory(vector),
            };
            if dead {
                let ordinal = append(&shared, &mut writer, doc_id, held, FLAG_REPLACED)?;
                ordinals[at] = ordinal as i32;
                self.tombstoned.push(ordinal);
                continue;
            }
            if let Some(previous) = writer.generation.ordinal_of(doc_id) {
                retire_previous(&mut writer, previous)?;
            }
            let in_memory = matches!(held, Held::InMemory(_));
            let ordinal = append(&shared, &mut writer, doc_id, held, FLAG_CURRENT)?;
            ordinals[at] = ordinal as i32;
            if on_disk
                && in_memory
                && let Some(location) = &loaded.location
            {
                writer
                    .pending_locations
                    .insert(ordinal, (location.path.clone(), offset));
            }
        }
        self.restore_records(&writer, file, &ordinals);
        self.files.push(RestoredFile {
            id: loaded.id,
            key: loaded.key,
            ordinals,
            coded: file.codes.is_some(),
        });
        Ok(())
    }

    fn restore_records(&mut self, writer: &Writer, file: &VectorFile, ordinals: &[i32]) {
        if !self.restores_codes || !self.codes_agree {
            return;
        }
        let store = &writer.generation.store;
        let record_bytes = store.record_bytes();
        let Some(codes) = &file.codes else {
            self.codes_agree = false;
            return;
        };
        if codes.bits != store.bits || codes.records.len() != ordinals.len() * record_bytes {
            self.codes_agree = false;
            return;
        }
        match &self.centroid {
            None => self.centroid = Some(codes.centroid.clone()),
            Some(held) if *held != codes.centroid => {
                self.codes_agree = false;
                return;
            }
            Some(_) => {}
        }
        for (at, &ordinal) in ordinals.iter().enumerate() {
            if let Ok(ordinal) = u32::try_from(ordinal) {
                store.write_record(
                    ordinal,
                    &codes.records[at * record_bytes..(at + 1) * record_bytes],
                );
            }
        }
    }
}

impl Drop for VectorRestore {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let shared = Arc::clone(&self.shared);
        let mut writer = shared.lock_writer();
        empty_writer(&shared, &mut writer);
        writer.holds_publication = false;
        shared.publish_held(&writer);
        shared.restoring.store(false, Ordering::Release);
    }
}
