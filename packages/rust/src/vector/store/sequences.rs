use std::sync::atomic::Ordering;

use super::StoreTables;

const NOT_RETIRED: i64 = 0;

impl StoreTables {
    pub(crate) fn stamp_born(&self, ordinal: u32, sequence: i64) {
        if let Some(entry) = self.born_at.get(ordinal as usize) {
            entry.store(sequence, Ordering::SeqCst);
        }
        if let Some(entry) = self.retired_at.get(ordinal as usize)
            && entry.load(Ordering::SeqCst) != NOT_RETIRED
        {
            entry.store(NOT_RETIRED, Ordering::SeqCst);
        }
    }

    pub(crate) fn stamp_retired(&self, ordinal: u32, sequence: i64) {
        if let Some(entry) = self.retired_at.get(ordinal as usize)
            && entry.load(Ordering::SeqCst) == NOT_RETIRED
        {
            entry.store(sequence, Ordering::SeqCst);
        }
    }

    pub(crate) fn born_at(&self, ordinal: u32) -> i64 {
        self.born_at
            .get(ordinal as usize)
            .map_or(0, |entry| entry.load(Ordering::SeqCst))
    }

    pub(crate) fn set_earlier_ordinal(&self, ordinal: u32, earlier: u32) {
        if let Some(entry) = self.earlier_ordinal.get(ordinal as usize) {
            entry.store(earlier as i32, Ordering::Release);
        }
    }

    pub(crate) fn earlier_ordinal(&self, ordinal: u32) -> Option<u32> {
        self.earlier_ordinal
            .get(ordinal as usize)
            .and_then(|entry| u32::try_from(entry.load(Ordering::Acquire)).ok())
    }

    pub(crate) fn retired_at(&self, ordinal: u32) -> i64 {
        self.retired_at
            .get(ordinal as usize)
            .map_or(NOT_RETIRED, |entry| entry.load(Ordering::SeqCst))
    }

    pub(crate) fn may_free(&self, ordinal: u32, oldest_pin: i64) -> bool {
        let retired = self.retired_at(ordinal);
        retired > NOT_RETIRED && retired <= oldest_pin
    }

    pub(crate) fn oldest_pin(&self) -> i64 {
        self.sequence
            .as_ref()
            .map_or(crate::pins::NO_HELD_PIN, |sequence| sequence.oldest_pin())
    }

    pub(crate) fn write_sequence(&self) -> i64 {
        self.write_sequence.load(Ordering::SeqCst)
    }

    pub(crate) fn record_write_sequence(&self, sequence: i64) {
        self.write_sequence.store(sequence, Ordering::SeqCst);
    }

    pub(crate) fn sequence_bytes(&self) -> usize {
        (self.born_at.len() + self.retired_at.len()) * size_of::<i64>()
            + self.earlier_ordinal.len() * size_of::<i32>()
    }
}
