use std::sync::atomic::Ordering;

use super::StoreTables;

const NOT_RETIRED: i64 = 0;
const NOT_BORN: i64 = 0;

impl StoreTables {
    fn record_stamp(&self, sequence: i64) {
        if let Some(index_sequence) = &self.sequence {
            index_sequence.record_stamp(sequence);
        }
    }

    pub(crate) fn stamp_born(&self, ordinal: u32, sequence: i64) {
        self.record_stamp(sequence);
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
            self.record_stamp(sequence);
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
            .map_or(crate::pins::NO_HELD_PIN, |sequence| {
                sequence.oldest_pin().min(sequence.current())
            })
    }

    pub(crate) fn stamped_after(&self, pin: i64) -> bool {
        self.sequence
            .as_ref()
            .is_some_and(|sequence| sequence.stamped_after(pin))
    }

    pub(crate) fn admitted_count(&self, pin: i64) -> u64 {
        (0..self.slots())
            .filter(|&ordinal| {
                let retired = self.retired_at(ordinal);
                let born = self.born_at(ordinal);
                (retired == NOT_RETIRED || retired > pin) && born != NOT_BORN && born <= pin
            })
            .count() as u64
    }

    pub(crate) fn sequence_bytes(&self) -> usize {
        (self.born_at.len() + self.retired_at.len()) * size_of::<i64>()
            + self.earlier_ordinal.len() * size_of::<i32>()
    }
}
