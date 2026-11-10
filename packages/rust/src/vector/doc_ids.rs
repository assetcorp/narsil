use std::hash::{BuildHasher, RandomState};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU32, Ordering};

use super::constants::{
    DOC_ID_CHUNK_ORDINALS, ID_TABLE_MAX_LOAD_PERCENT, MAX_VECTOR_ORDINALS, MIN_ID_TABLE_SLOTS,
};

const EMPTY_SLOT: u32 = 0;
const DELETED_SLOT: u32 = u32::MAX;

type NameChunk = Box<[OnceLock<Box<str>>]>;

pub(crate) struct OrdinalNames {
    chunks: Box<[OnceLock<NameChunk>]>,
}

impl OrdinalNames {
    pub(crate) fn new() -> OrdinalNames {
        let count = (MAX_VECTOR_ORDINALS as usize).div_ceil(DOC_ID_CHUNK_ORDINALS);
        OrdinalNames {
            chunks: (0..count).map(|_| OnceLock::new()).collect(),
        }
    }

    pub(crate) fn get(&self, ordinal: u32) -> Option<&str> {
        let at = ordinal as usize;
        let chunk = self.chunks.get(at / DOC_ID_CHUNK_ORDINALS)?.get()?;
        chunk
            .get(at % DOC_ID_CHUNK_ORDINALS)?
            .get()
            .map(|name| &**name)
    }

    pub(crate) fn set(&self, ordinal: u32, doc_id: &str) {
        let at = ordinal as usize;
        let Some(cell) = self.chunks.get(at / DOC_ID_CHUNK_ORDINALS) else {
            return;
        };
        let chunk = cell.get_or_init(|| {
            (0..DOC_ID_CHUNK_ORDINALS)
                .map(|_| OnceLock::new())
                .collect()
        });
        if let Some(slot) = chunk.get(at % DOC_ID_CHUNK_ORDINALS) {
            let _ = slot.set(doc_id.into());
        }
    }
}

pub(crate) struct IdTable {
    slots: Box<[AtomicU32]>,
    mask: usize,
    hasher: RandomState,
}

pub(crate) enum Placed {
    Updated,
    Added,
}

impl IdTable {
    pub(crate) fn for_entries(entries: usize, hasher: RandomState) -> IdTable {
        let wanted = entries.saturating_mul(100) / ID_TABLE_MAX_LOAD_PERCENT + 1;
        let size = wanted.max(MIN_ID_TABLE_SLOTS).next_power_of_two();
        IdTable {
            slots: (0..size).map(|_| AtomicU32::new(EMPTY_SLOT)).collect(),
            mask: size - 1,
            hasher,
        }
    }

    pub(crate) fn fits(&self, used: usize) -> bool {
        used.saturating_mul(100) < self.slots.len() * ID_TABLE_MAX_LOAD_PERCENT
    }

    pub(crate) fn memory_bytes(&self) -> usize {
        self.slots.len() * 4
    }

    fn start(&self, doc_id: &str) -> usize {
        (self.hasher.hash_one(doc_id) as usize) & self.mask
    }

    pub(crate) fn find(&self, doc_id: &str, names: &OrdinalNames) -> Option<u32> {
        self.position(doc_id, names).map(|(_, ordinal)| ordinal)
    }

    fn position(&self, doc_id: &str, names: &OrdinalNames) -> Option<(usize, u32)> {
        let mut at = self.start(doc_id);
        for _ in 0..self.slots.len() {
            let value = self.slots[at].load(Ordering::Acquire);
            if value == EMPTY_SLOT {
                return None;
            }
            if value != DELETED_SLOT && names.get(value - 1) == Some(doc_id) {
                return Some((at, value - 1));
            }
            at = (at + 1) & self.mask;
        }
        None
    }

    pub(crate) fn put(&self, doc_id: &str, ordinal: u32, names: &OrdinalNames) -> Placed {
        if let Some((at, _)) = self.position(doc_id, names) {
            self.slots[at].store(ordinal + 1, Ordering::Release);
            return Placed::Updated;
        }
        let mut at = self.start(doc_id);
        for _ in 0..self.slots.len() {
            let value = self.slots[at].load(Ordering::Acquire);
            if value == EMPTY_SLOT || value == DELETED_SLOT {
                self.slots[at].store(ordinal + 1, Ordering::Release);
                return if value == EMPTY_SLOT {
                    Placed::Added
                } else {
                    Placed::Updated
                };
            }
            at = (at + 1) & self.mask;
        }
        Placed::Updated
    }

    pub(crate) fn delete(&self, doc_id: &str, names: &OrdinalNames) -> bool {
        match self.position(doc_id, names) {
            Some((at, _)) => {
                self.slots[at].store(DELETED_SLOT, Ordering::Release);
                true
            }
            None => false,
        }
    }

    pub(crate) fn ordinals(&self) -> impl Iterator<Item = u32> + '_ {
        self.slots.iter().filter_map(|slot| {
            let value = slot.load(Ordering::Acquire);
            (value != EMPTY_SLOT && value != DELETED_SLOT).then(|| value - 1)
        })
    }

    pub(crate) fn rebuilt(&self, live: usize, names: &OrdinalNames) -> IdTable {
        let table = IdTable::for_entries(live, self.hasher.clone());
        for ordinal in self.ordinals() {
            if let Some(doc_id) = names.get(ordinal) {
                table.put(doc_id, ordinal, names);
            }
        }
        table
    }
}
