mod blocks;

use std::ptr;
mod sequences;

use std::sync::atomic::{
    AtomicI32, AtomicI64, AtomicPtr, AtomicU8, AtomicU32, AtomicU64, Ordering,
};
use std::sync::{Arc, OnceLock};

use crate::ffi;
use crate::pins::IndexSequence;

use super::constants::VECTORS_PER_BLOCK;
use super::files::{FileList, MappedFile};
use super::region::{
    byte_ptr, bytes, copied_bytes, copied_doubles, copied_floats, copied_sequences, copied_words,
    double_ptr, float_ptr, floats, load, load_byte, sequence_ptr, sequences, store, store_byte,
    unsigned_ptr, word_ptr, words,
};

pub(crate) const FLAG_CURRENT: u8 = 1;
pub(crate) const FLAG_REMOVED: u8 = 2;
pub(crate) const FLAG_BUFFERED: u8 = 4;
pub(crate) const FLAG_REPLACED: u8 = 8;

const STORE_WORD_HELD_DOCUMENTS: usize = ffi::NARSIL_STORE_WORD_LIVE_COUNT;
const FLOATS_PER_LANE: usize = 4;
const IN_A_BLOCK: i32 = ffi::NARSIL_VECTOR_IN_A_BLOCK;
const NO_EARLIER_ORDINAL: i32 = -1;

struct VectorBlock {
    floats: Box<[AtomicU32]>,
}

struct CodeBlock {
    bytes: Box<[AtomicU8]>,
}

pub(crate) struct StoreTables {
    pub(crate) dimension: usize,
    pub(crate) bits: u8,
    stride: usize,
    record_bytes: usize,
    capacity: usize,
    header: Box<[AtomicI32]>,
    centroid: Box<[AtomicU32]>,
    present: Box<[AtomicU8]>,
    code_present: Box<[AtomicU8]>,
    flags: Box<[AtomicU8]>,
    magnitudes: Box<[AtomicU64]>,
    vector_file: Box<[AtomicI32]>,
    vector_offset: Box<[AtomicU32]>,
    vector_blocks: Box<[AtomicPtr<f32>]>,
    vector_owners: Box<[OnceLock<Arc<VectorBlock>>]>,
    code_blocks: Box<[AtomicPtr<u8>]>,
    code_owners: Box<[OnceLock<Arc<CodeBlock>>]>,
    files: FileList,
    born_at: Box<[AtomicI64]>,
    retired_at: Box<[AtomicI64]>,
    earlier_ordinal: Box<[AtomicI32]>,
    write_sequence: AtomicI64,
    sequence: Option<Arc<IndexSequence>>,
}

pub(crate) fn record_bytes_of(dimension: usize, bits: u8) -> usize {
    if bits == 0 {
        return 0;
    }
    unsafe { ffi::narsil_record_bytes(dimension as u32, u32::from(bits)) as usize }
}

pub(crate) fn magnitude_of(vector: &[f32]) -> f64 {
    let whole = vector.len() - vector.len() % FLOATS_PER_LANE;
    let mut lanes = [0f32; FLOATS_PER_LANE];
    for chunk in vector[..whole].chunks_exact(FLOATS_PER_LANE) {
        for (lane, value) in lanes.iter_mut().zip(chunk) {
            *lane += value * value;
        }
    }
    let mut sum = (lanes[0] + lanes[1]) + (lanes[2] + lanes[3]);
    for value in &vector[whole..] {
        sum += value * value;
    }
    f64::from(sum.sqrt())
}

fn block_count(capacity: usize) -> usize {
    capacity.div_ceil(VECTORS_PER_BLOCK as usize)
}

fn empty_pointers<T>(count: usize) -> Box<[AtomicPtr<T>]> {
    (0..count)
        .map(|_| AtomicPtr::new(ptr::null_mut()))
        .collect()
}

fn empty_owners<T>(count: usize) -> Box<[OnceLock<T>]> {
    (0..count).map(|_| OnceLock::new()).collect()
}

impl StoreTables {
    pub(crate) fn new(
        dimension: usize,
        bits: u8,
        capacity: usize,
        sequence: Option<Arc<IndexSequence>>,
    ) -> StoreTables {
        let blocks = block_count(capacity);
        let write_sequence = sequence
            .as_ref()
            .map_or(crate::pins::FIRST_WRITE_SEQUENCE, |found| found.current());
        StoreTables {
            dimension,
            bits,
            stride: dimension.div_ceil(FLOATS_PER_LANE) * FLOATS_PER_LANE,
            record_bytes: record_bytes_of(dimension, bits),
            capacity,
            header: words(ffi::NARSIL_STORE_HEADER_WORDS, 0),
            centroid: floats(dimension),
            present: bytes(capacity),
            code_present: bytes(capacity),
            flags: bytes(capacity),
            magnitudes: copied_doubles(&[], capacity),
            vector_file: words(capacity, IN_A_BLOCK),
            vector_offset: floats(capacity),
            vector_blocks: empty_pointers(blocks),
            vector_owners: empty_owners(blocks),
            code_blocks: empty_pointers(blocks),
            code_owners: empty_owners(blocks),
            files: FileList::empty(),
            born_at: sequences(capacity),
            retired_at: sequences(capacity),
            earlier_ordinal: words(capacity, NO_EARLIER_ORDINAL),
            write_sequence: AtomicI64::new(write_sequence),
            sequence,
        }
    }

    pub(crate) fn copied(
        &self,
        capacity: usize,
        files: Vec<Arc<MappedFile>>,
        keeps_vector_block: &dyn Fn(usize) -> bool,
    ) -> StoreTables {
        self.copied_with(capacity, files, keeps_vector_block, true)
    }

    fn copied_with(
        &self,
        capacity: usize,
        files: Vec<Arc<MappedFile>>,
        keeps_vector_block: &dyn Fn(usize) -> bool,
        shares_codes: bool,
    ) -> StoreTables {
        let blocks = block_count(capacity);
        let vector_owners: Box<[OnceLock<Arc<VectorBlock>>]> = empty_owners(blocks);
        let code_owners: Box<[OnceLock<Arc<CodeBlock>>]> = empty_owners(blocks);
        let vector_blocks: Box<[AtomicPtr<f32>]> = empty_pointers(blocks);
        let code_blocks: Box<[AtomicPtr<u8>]> = empty_pointers(blocks);
        for at in 0..blocks.min(self.vector_owners.len()) {
            if let Some(block) = self.vector_owners[at].get()
                && keeps_vector_block(at)
            {
                vector_blocks[at].store(float_ptr(&block.floats), Ordering::Release);
                let _ = vector_owners[at].set(Arc::clone(block));
            }
            if shares_codes && let Some(block) = self.code_owners[at].get() {
                code_blocks[at].store(byte_ptr(&block.bytes), Ordering::Release);
                let _ = code_owners[at].set(Arc::clone(block));
            }
        }
        let header = copied_words(&self.header, self.header.len(), 0);
        let code_present = if shares_codes {
            copied_bytes(&self.code_present, capacity)
        } else {
            store(&header, ffi::NARSIL_STORE_WORD_CODE_COUNT, 0);
            bytes(capacity)
        };
        StoreTables {
            dimension: self.dimension,
            bits: self.bits,
            stride: self.stride,
            record_bytes: self.record_bytes,
            capacity,
            header,
            centroid: copied_floats(&self.centroid, self.dimension),
            present: copied_bytes(&self.present, capacity),
            code_present,
            flags: copied_bytes(&self.flags, capacity),
            magnitudes: copied_doubles(&self.magnitudes, capacity),
            vector_file: copied_words(&self.vector_file, capacity, IN_A_BLOCK),
            vector_offset: copied_floats(&self.vector_offset, capacity),
            vector_blocks,
            vector_owners,
            code_blocks,
            code_owners,
            files: FileList::of(files),
            born_at: copied_sequences(&self.born_at, capacity),
            retired_at: copied_sequences(&self.retired_at, capacity),
            earlier_ordinal: copied_words(&self.earlier_ordinal, capacity, NO_EARLIER_ORDINAL),
            write_sequence: AtomicI64::new(self.write_sequence.load(Ordering::SeqCst)),
            sequence: self.sequence.clone(),
        }
    }

    pub(crate) fn raw(&self) -> ffi::narsil_store {
        let (pins, pin_slots) = match &self.sequence {
            Some(sequence) => (sequence.pins().as_ptr(), sequence.pins().slots()),
            None => (ptr::null(), 0),
        };
        ffi::narsil_store {
            header: word_ptr(&self.header),
            dimension: self.dimension as u32,
            bits: u32::from(self.bits),
            code_blocks: self.code_blocks.as_ptr().cast::<*mut u8>(),
            code_block_count: self.code_blocks.len() as u32,
            records_per_block: if self.bits == 0 { 0 } else { VECTORS_PER_BLOCK },
            code_present: byte_ptr(&self.code_present),
            centroid: float_ptr(&self.centroid),
            vector_blocks: self.vector_blocks.as_ptr().cast::<*const f32>(),
            vector_block_count: self.vector_blocks.len() as u32,
            vectors_per_block: VECTORS_PER_BLOCK,
            vector_stride_floats: self.stride as u32,
            magnitudes: double_ptr(&self.magnitudes),
            present: byte_ptr(&self.present),
            vector_file: word_ptr(&self.vector_file).cast_const(),
            vector_offset: unsigned_ptr(&self.vector_offset),
            files: self.files.raw_ptr(),
            file_count: self.files.len() as u32,
            born_at: sequence_ptr(&self.born_at),
            retired_at: sequence_ptr(&self.retired_at),
            pins,
            pin_slots,
        }
    }

    pub(crate) fn capacity(&self) -> usize {
        self.capacity
    }

    pub(crate) fn record_bytes(&self) -> usize {
        self.record_bytes
    }

    pub(crate) fn files(&self) -> &FileList {
        &self.files
    }

    pub(crate) fn word(&self, at: usize) -> i32 {
        load(&self.header, at)
    }

    pub(crate) fn set_word(&self, at: usize, value: i32) {
        store(&self.header, at, value);
    }

    pub(crate) fn slots(&self) -> u32 {
        self.word(ffi::NARSIL_STORE_WORD_SLOTS).max(0) as u32
    }

    pub(crate) fn set_slots(&self, slots: u32) {
        self.set_word(ffi::NARSIL_STORE_WORD_SLOTS, slots as i32);
    }

    pub(crate) fn set_held_documents(&self, held: u64) {
        self.set_word(STORE_WORD_HELD_DOCUMENTS, held.min(i32::MAX as u64) as i32);
    }

    pub(crate) fn calibrated(&self) -> bool {
        self.word(ffi::NARSIL_STORE_WORD_CALIBRATED) == 1
    }

    pub(crate) fn code_count(&self) -> u32 {
        self.word(ffi::NARSIL_STORE_WORD_CODE_COUNT).max(0) as u32
    }

    pub(crate) fn calibration_generation(&self) -> i32 {
        self.word(ffi::NARSIL_STORE_WORD_CALIBRATION_GENERATION)
    }

    pub(crate) fn centroid(&self) -> Vec<f32> {
        self.centroid
            .iter()
            .map(|word| f32::from_bits(word.load(Ordering::Acquire)))
            .collect()
    }

    pub(crate) fn set_centroid(&self, centroid: &[f32]) {
        for (word, value) in self.centroid.iter().zip(centroid) {
            word.store(value.to_bits(), Ordering::Release);
        }
        self.set_word(
            ffi::NARSIL_STORE_WORD_CALIBRATION_GENERATION,
            self.calibration_generation().wrapping_add(1),
        );
        self.set_word(ffi::NARSIL_STORE_WORD_CALIBRATED, 1);
    }

    pub(crate) fn forget_calibration(&self) {
        for word in self.centroid.iter() {
            word.store(0, Ordering::Release);
        }
        self.set_word(ffi::NARSIL_STORE_WORD_CALIBRATED, 0);
        self.set_word(
            ffi::NARSIL_STORE_WORD_CALIBRATION_GENERATION,
            self.calibration_generation().wrapping_add(1),
        );
    }

    pub(crate) fn flags(&self, ordinal: u32) -> u8 {
        load_byte(&self.flags, ordinal as usize)
    }

    pub(crate) fn set_flags(&self, ordinal: u32, value: u8) {
        store_byte(&self.flags, ordinal as usize, value);
    }

    pub(crate) fn is_live(&self, ordinal: u32) -> bool {
        self.flags(ordinal) & (FLAG_CURRENT | FLAG_REMOVED) == FLAG_CURRENT
    }

    pub(crate) fn present(&self, ordinal: u32) -> bool {
        load_byte(&self.present, ordinal as usize) == 1
    }

    pub(crate) fn set_present(&self, ordinal: u32, present: bool) {
        store_byte(&self.present, ordinal as usize, u8::from(present));
    }

    pub(crate) fn magnitude(&self, ordinal: u32) -> f64 {
        self.magnitudes
            .get(ordinal as usize)
            .map_or(0.0, |word| f64::from_bits(word.load(Ordering::Acquire)))
    }

    pub(crate) fn has_code(&self, ordinal: u32) -> bool {
        load_byte(&self.code_present, ordinal as usize) == 1
    }
}
