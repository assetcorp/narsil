use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};

use crate::ffi;

use super::super::constants::VECTORS_PER_BLOCK;
use super::super::files::MappedFile;
use super::super::region::{byte_ptr, bytes, float_ptr, floats, load, store};
use super::{CodeBlock, IN_A_BLOCK, StoreTables, VectorBlock};

impl StoreTables {
    pub(crate) fn recoded_copy(&self) -> StoreTables {
        let copy = self.copied_with(
            self.capacity,
            self.files.owners().to_vec(),
            &|_| true,
            false,
        );
        for (block, owner) in self.code_owners.iter().enumerate() {
            if owner.get().is_some() {
                copy.ensure_code_block(block as u32 * VECTORS_PER_BLOCK);
            }
        }
        copy
    }

    pub(crate) fn with_files(&self, files: Vec<Arc<MappedFile>>) -> StoreTables {
        self.copied(self.capacity, files, &|_| true)
    }

    pub(crate) fn without_file_blocks(&self) -> StoreTables {
        self.copied(self.capacity, self.files.owners().to_vec(), &|block| {
            !self.block_reads_from_files(block)
        })
    }

    fn vector_block(&self, block: usize) -> Option<&VectorBlock> {
        let owner = self.vector_owners.get(block)?;
        if let Some(found) = owner.get() {
            return Some(found);
        }
        let made = owner.get_or_init(|| {
            Arc::new(VectorBlock {
                floats: floats(VECTORS_PER_BLOCK as usize * self.stride),
            })
        });
        self.vector_blocks[block].store(float_ptr(&made.floats), Ordering::Release);
        Some(made)
    }

    pub(crate) fn ensure_code_block(&self, ordinal: u32) {
        if self.bits == 0 {
            return;
        }
        let block = (ordinal / VECTORS_PER_BLOCK) as usize;
        let Some(owner) = self.code_owners.get(block) else {
            return;
        };
        if owner.get().is_some() {
            return;
        }
        let made = owner.get_or_init(|| {
            Arc::new(CodeBlock {
                bytes: bytes(VECTORS_PER_BLOCK as usize * self.record_bytes),
            })
        });
        self.code_blocks[block].store(byte_ptr(&made.bytes), Ordering::Release);
    }

    pub(crate) fn write_vector(&self, ordinal: u32, vector: &[f32], magnitude: f64) {
        let block = (ordinal / VECTORS_PER_BLOCK) as usize;
        let entry = (ordinal % VECTORS_PER_BLOCK) as usize * self.stride;
        if let Some(found) = self.vector_block(block) {
            for (word, value) in found.floats[entry..entry + self.dimension]
                .iter()
                .zip(vector)
            {
                word.store(value.to_bits(), Ordering::Relaxed);
            }
        }
        self.write_location(ordinal, magnitude, IN_A_BLOCK, 0);
    }

    pub(crate) fn write_location(&self, ordinal: u32, magnitude: f64, file: i32, offset: u32) {
        let at = ordinal as usize;
        if let Some(word) = self.magnitudes.get(at) {
            word.store(magnitude.to_bits(), Ordering::Release);
        }
        if let Some(word) = self.vector_offset.get(at) {
            word.store(offset, Ordering::Release);
        }
        store(&self.vector_file, at, file);
        self.ensure_code_block(ordinal);
    }

    pub(crate) fn file_of(&self, ordinal: u32) -> Option<(usize, u64)> {
        let file = load(&self.vector_file, ordinal as usize);
        if file < 0 {
            return None;
        }
        let offset = self
            .vector_offset
            .get(ordinal as usize)?
            .load(Ordering::Acquire);
        Some((file as usize, u64::from(offset)))
    }

    pub(crate) fn read_vector(&self, ordinal: u32, out: &mut [f32]) -> bool {
        if out.len() != self.dimension || ordinal as usize >= self.capacity {
            return false;
        }
        if let Some((file, offset)) = self.file_of(ordinal) {
            return self
                .files
                .get(file)
                .is_some_and(|found| found.read_floats(offset, out));
        }
        let block = (ordinal / VECTORS_PER_BLOCK) as usize;
        let Some(found) = self.vector_owners.get(block).and_then(OnceLock::get) else {
            return false;
        };
        let entry = (ordinal % VECTORS_PER_BLOCK) as usize * self.stride;
        for (value, word) in out
            .iter_mut()
            .zip(&found.floats[entry..entry + self.dimension])
        {
            *value = f32::from_bits(word.load(Ordering::Relaxed));
        }
        true
    }

    pub(crate) fn read_record(&self, ordinal: u32, out: &mut [u8]) -> bool {
        if self.bits == 0 || out.len() != self.record_bytes || !self.has_code(ordinal) {
            return false;
        }
        let block = (ordinal / VECTORS_PER_BLOCK) as usize;
        let Some(found) = self.code_owners.get(block).and_then(OnceLock::get) else {
            return false;
        };
        let start = (ordinal % VECTORS_PER_BLOCK) as usize * self.record_bytes;
        for (value, byte) in out
            .iter_mut()
            .zip(&found.bytes[start..start + self.record_bytes])
        {
            *value = byte.load(Ordering::Relaxed);
        }
        true
    }

    pub(crate) fn write_record(&self, ordinal: u32, record: &[u8]) {
        if self.bits == 0 || record.len() != self.record_bytes {
            return;
        }
        self.ensure_code_block(ordinal);
        let block = (ordinal / VECTORS_PER_BLOCK) as usize;
        let Some(found) = self.code_owners.get(block).and_then(OnceLock::get) else {
            return;
        };
        let start = (ordinal % VECTORS_PER_BLOCK) as usize * self.record_bytes;
        for (byte, value) in found.bytes[start..start + self.record_bytes]
            .iter()
            .zip(record)
        {
            byte.store(*value, Ordering::Relaxed);
        }
        if let Some(flag) = self.code_present.get(ordinal as usize)
            && flag.swap(1, Ordering::AcqRel) == 0
        {
            self.set_word(
                ffi::NARSIL_STORE_WORD_CODE_COUNT,
                self.code_count() as i32 + 1,
            );
        }
    }

    pub(crate) fn clear_code(&self, ordinal: u32) {
        if let Some(flag) = self.code_present.get(ordinal as usize)
            && flag.swap(0, Ordering::AcqRel) == 1
        {
            self.set_word(
                ffi::NARSIL_STORE_WORD_CODE_COUNT,
                (self.code_count() as i32 - 1).max(0),
            );
        }
    }

    pub(crate) fn clear_every_code(&self) {
        for flag in self.code_present.iter() {
            flag.store(0, Ordering::Release);
        }
        self.set_word(ffi::NARSIL_STORE_WORD_CODE_COUNT, 0);
    }

    pub(crate) fn vector_block_held(&self, block: usize) -> bool {
        self.vector_owners
            .get(block)
            .is_some_and(|owner| owner.get().is_some())
    }

    pub(crate) fn block_reads_from_files(&self, block: usize) -> bool {
        let start = block * VECTORS_PER_BLOCK as usize;
        let end = (start + VECTORS_PER_BLOCK as usize).min(self.slots() as usize);
        (start..end).all(|at| !self.present(at as u32) || load(&self.vector_file, at) >= 0)
    }

    pub(crate) fn memory_bytes(&self) -> usize {
        let per_ordinal = 1 + 1 + 1 + 8 + 4 + 4;
        let vector_bytes = self.stride * 4 * VECTORS_PER_BLOCK as usize;
        let code_bytes = self.record_bytes * VECTORS_PER_BLOCK as usize;
        let held_vector_blocks = (0..self.vector_owners.len())
            .filter(|&at| self.vector_block_held(at))
            .count();
        let held_code_blocks = self
            .code_owners
            .iter()
            .filter(|owner| owner.get().is_some())
            .count();
        self.capacity * per_ordinal
            + held_vector_blocks * vector_bytes
            + held_code_blocks * code_bytes
            + self.dimension * 4
            + ffi::NARSIL_STORE_HEADER_WORDS * 4
            + self.sequence_bytes()
    }
}
