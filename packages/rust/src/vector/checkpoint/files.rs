use crate::error::Result;
use crate::format::vector_file::{DiskColumns, VectorCodes, VectorFile, positions_in_id_order};

use super::super::core::with_scratch;
use super::super::numbered::NO_ORDINAL;
use super::super::store::StoreTables;
use super::{VectorCheckpointPlan, dead_bits_where};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NewVectorFile {
    pub(crate) file: VectorFile,
    pub(crate) ordinals: Vec<i32>,
    pub(crate) dead: Option<Vec<u8>>,
}

impl VectorCheckpointPlan {
    pub(crate) fn read_new_file(&mut self, index: usize) -> Result<NewVectorFile> {
        let store = &self.generation.store;
        let dimension = store.dimension;
        let start = (index * self.capacity).min(self.planned.len());
        let end = (start + self.capacity).min(self.planned.len());
        let planned = &self.planned[start..end];
        let mut vectors = vec![0f32; planned.len() * dimension];
        let mut magnitudes = vec![0f64; planned.len()];
        let mut ordinals = vec![NO_ORDINAL; planned.len()];
        for (at, vector) in planned.iter().enumerate() {
            let slot = &mut vectors[at * dimension..(at + 1) * dimension];
            if store.read_vector(vector.ordinal, slot) {
                magnitudes[at] = store.magnitude(vector.ordinal);
                ordinals[at] = vector.ordinal as i32;
            }
        }
        let doc_ids: Vec<String> = planned.iter().map(|vector| vector.doc_id.clone()).collect();
        let codes = match &self.centroid {
            Some(centroid) => Some(self.codes_of(centroid, &vectors, &ordinals)?),
            None => None,
        };
        let dead = dead_bits_where(planned.len(), |at| {
            planned[at].tombstoned || ordinals[at] == NO_ORDINAL
        });
        let first = self.first_written_number + start;
        for (at, &ordinal) in ordinals.iter().enumerate() {
            if ordinal == NO_ORDINAL {
                let number = first + at;
                if self.vanished.len() <= number {
                    self.vanished.resize(number + 1, false);
                }
                self.vanished[number] = true;
            }
        }
        let disk = self.stores_heads.then(|| DiskColumns {
            magnitudes,
            id_order: positions_in_id_order(&doc_ids),
        });
        Ok(NewVectorFile {
            file: VectorFile {
                field_name: self.field_name.clone(),
                dimension,
                doc_ids,
                codes,
                vectors,
                disk,
            },
            ordinals,
            dead,
        })
    }

    fn codes_of(&self, centroid: &[f32], vectors: &[f32], ordinals: &[i32]) -> Result<VectorCodes> {
        let store = &self.generation.store;
        let dimension = store.dimension;
        let record_bytes = store.record_bytes();
        let mut records = vec![0u8; ordinals.len() * record_bytes];
        let same_centroid = store.calibrated() && store.centroid() == centroid;
        let mut missing = Vec::new();
        for (at, &ordinal) in ordinals.iter().enumerate() {
            if ordinal == NO_ORDINAL {
                continue;
            }
            let record = &mut records[at * record_bytes..(at + 1) * record_bytes];
            if !(same_centroid && store.read_record(ordinal as u32, record)) {
                missing.push(at);
            }
        }
        if !missing.is_empty() {
            let coder = StoreTables::new(dimension, store.bits, missing.len());
            for (slot, &at) in missing.iter().enumerate() {
                let vector = &vectors[at * dimension..(at + 1) * dimension];
                coder.write_vector(
                    slot as u32,
                    vector,
                    super::super::store::magnitude_of(vector),
                );
                coder.set_present(slot as u32, true);
            }
            coder.set_slots(missing.len() as u32);
            coder.set_centroid(centroid);
            let slots: Vec<i32> = (0..missing.len() as i32).collect();
            let metric = self.metric;
            with_scratch(|scratch| scratch.quantise(&coder, metric, &slots))?;
            for (slot, &at) in missing.iter().enumerate() {
                let record = &mut records[at * record_bytes..(at + 1) * record_bytes];
                coder.read_record(slot as u32, record);
            }
        }
        Ok(VectorCodes {
            bits: store.bits,
            centroid: centroid.iter().map(|&value| f64::from(value)).collect(),
            records,
        })
    }
}
