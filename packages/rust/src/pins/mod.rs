mod constants;
mod slots;

use std::marker::PhantomData;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use crate::error::Result;
use crate::util::zeroed::zeroed_slice;

pub(crate) use constants::{FIRST_WRITE_SEQUENCE, LOADED_SEQUENCE, MAX_THREAD_SLOTS, NO_HELD_PIN};
pub(crate) use slots::{slots_reached, thread_slot};

pub(crate) struct PinTable {
    entries: Box<[AtomicI64]>,
}

impl PinTable {
    fn new() -> PinTable {
        PinTable {
            entries: zeroed_slice(MAX_THREAD_SLOTS as usize),
        }
    }

    fn load(&self, slot: u32) -> i64 {
        self.entries
            .get(slot as usize)
            .map_or(constants::NO_PIN, |entry| entry.load(Ordering::SeqCst))
    }

    fn store(&self, slot: u32, value: i64) {
        if let Some(entry) = self.entries.get(slot as usize) {
            entry.store(value, Ordering::SeqCst);
        }
    }

    pub(crate) fn as_ptr(&self) -> *const i64 {
        self.entries.as_ptr().cast::<i64>()
    }

    pub(crate) fn slots(&self) -> u32 {
        slots_reached().min(MAX_THREAD_SLOTS)
    }

    fn oldest(&self) -> i64 {
        let mut oldest = NO_HELD_PIN;
        for slot in 0..self.slots() {
            let entry = self.load(slot);
            if entry != constants::NO_PIN && entry - 1 < oldest {
                oldest = entry - 1;
            }
        }
        oldest
    }
}

pub(crate) struct IndexSequence {
    word: AtomicI64,
    highest_stamp: AtomicI64,
    pins: Arc<PinTable>,
}

impl Default for IndexSequence {
    fn default() -> IndexSequence {
        IndexSequence {
            word: AtomicI64::new(FIRST_WRITE_SEQUENCE),
            highest_stamp: AtomicI64::new(FIRST_WRITE_SEQUENCE),
            pins: Arc::new(PinTable::new()),
        }
    }
}

impl IndexSequence {
    pub(crate) fn current(&self) -> i64 {
        self.word.load(Ordering::SeqCst)
    }

    pub(crate) fn record_stamp(&self, sequence: i64) {
        self.highest_stamp.fetch_max(sequence, Ordering::SeqCst);
    }

    pub(crate) fn stamped_after(&self, pin: i64) -> bool {
        self.highest_stamp.load(Ordering::SeqCst) > pin
    }

    pub(crate) fn next(&self) -> i64 {
        self.current() + 1
    }

    pub(crate) fn publish(&self, sequence: i64) {
        self.word.store(sequence, Ordering::SeqCst);
    }

    pub(crate) fn pins(&self) -> &PinTable {
        &self.pins
    }

    pub(crate) fn oldest_pin(&self) -> i64 {
        self.pins.oldest()
    }

    pub(crate) fn pin(self: &Arc<IndexSequence>) -> Result<Pin> {
        let value = slots::take_pin(&self.pins, &|| self.current())?;
        Ok(Pin {
            sequence: Arc::clone(self),
            value,
            thread: PhantomData,
        })
    }
}

pub(crate) struct Pin {
    sequence: Arc<IndexSequence>,
    value: i64,
    thread: PhantomData<*const ()>,
}

impl Pin {
    pub(crate) fn value(&self) -> i64 {
        self.value
    }
}

impl Drop for Pin {
    fn drop(&mut self) {
        slots::release_pin(&self.sequence.pins, self.value);
    }
}
