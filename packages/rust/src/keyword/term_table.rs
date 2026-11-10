use super::constants::{
    TERM_REGION_GROWTH_FACTOR, TERM_SLOT_LOAD_DENOMINATOR, TERM_SLOT_LOAD_NUMERATOR,
    TERM_UNITS_START_CAPACITY,
};
use super::slices::{grow_to, region_full};
use crate::error::Result;
use crate::ffi;

pub(crate) const HEADER_WORDS: usize = 8;
pub(crate) const COUNT: usize = 0;
pub(crate) const LIVE_COUNT: usize = 1;
pub(crate) const SLOT_CAPACITY: usize = 2;
pub(crate) const GENERATION: usize = 3;
pub(crate) const UNITS_USED: usize = 4;
const FIRST_UNIT_COUNT: usize = 0x10000;
const LAST_SLOT_ORDINAL: usize = 0x7fff_fffe;
const LAST_SLOT_CAPACITY: usize = 0x8000_0000;
const LAST_OFFSET: usize = u32::MAX as usize;
const FNV_OFFSET_BASIS: u32 = 2_166_136_261;
const FNV_PRIME: u32 = 16_777_619;

pub(crate) fn term_hash(units: &[u16]) -> u32 {
    let mut hash = FNV_OFFSET_BASIS;
    for &unit in units {
        hash = (hash ^ u32::from(unit & 0xff)).wrapping_mul(FNV_PRIME);
        hash = (hash ^ u32::from(unit >> 8)).wrapping_mul(FNV_PRIME);
    }
    hash
}

pub(crate) fn slots_holding(entries: usize) -> Result<usize> {
    let mut capacity = 2;
    while entries * TERM_SLOT_LOAD_DENOMINATOR >= capacity * TERM_SLOT_LOAD_NUMERATOR {
        capacity *= TERM_REGION_GROWTH_FACTOR;
        if capacity > LAST_SLOT_CAPACITY {
            return Err(region_full("hash slots"));
        }
    }
    Ok(capacity)
}

#[derive(Clone)]
pub(crate) struct TermTable {
    header: Box<[u32; HEADER_WORDS]>,
    slots: Vec<i32>,
    term_offset: Vec<u32>,
    term_length: Vec<u32>,
    first_unit_next: Vec<u32>,
    first_unit_head: Box<[u32]>,
    units: Vec<u16>,
    occupied: usize,
    accounted_count: usize,
    accounted_generation: u32,
}

impl TermTable {
    pub(crate) fn new(capacity: usize) -> TermTable {
        let mut slots = 2;
        while slots <= capacity {
            slots *= TERM_REGION_GROWTH_FACTOR;
        }
        let mut header = Box::new([0u32; HEADER_WORDS]);
        header[SLOT_CAPACITY] = slots as u32;
        TermTable {
            header,
            slots: vec![0; slots],
            term_offset: vec![0; capacity],
            term_length: vec![0; capacity],
            first_unit_next: vec![0; capacity],
            first_unit_head: vec![0; FIRST_UNIT_COUNT].into_boxed_slice(),
            units: vec![0; TERM_UNITS_START_CAPACITY],
            occupied: 0,
            accounted_count: 0,
            accounted_generation: 0,
        }
    }

    pub(crate) fn count(&self) -> usize {
        self.header[COUNT] as usize
    }

    pub(crate) fn live_count(&self) -> usize {
        self.header[LIVE_COUNT] as usize
    }

    pub(crate) fn units_used(&self) -> usize {
        self.header[UNITS_USED] as usize
    }

    pub(crate) fn capacity(&self) -> usize {
        self.term_offset.len()
    }

    pub(crate) fn text(&self, ordinal: usize) -> &[u16] {
        let (Some(&offset), Some(&length)) =
            (self.term_offset.get(ordinal), self.term_length.get(ordinal))
        else {
            return &[];
        };
        let start = offset as usize;
        self.units
            .get(start..start + length as usize)
            .unwrap_or_default()
    }

    fn occupied_slots(&mut self) -> usize {
        if self.header[GENERATION] != self.accounted_generation {
            self.accounted_generation = self.header[GENERATION];
            self.occupied = self.live_count();
            self.accounted_count = self.count();
        }
        let added = self.count().saturating_sub(self.accounted_count);
        self.accounted_count = self.count();
        self.occupied = (self.occupied + added).min(self.slots.len());
        self.occupied
    }

    pub(crate) fn reserve(&mut self, terms: usize, units: usize) -> Result<()> {
        let count = self.count();
        if terms > LAST_SLOT_ORDINAL + 1 || units > LAST_OFFSET {
            return Err(region_full("term table"));
        }
        let added = terms.saturating_sub(count);
        if terms > self.term_offset.len() {
            let capacity = terms
                .max(self.term_offset.len() * TERM_REGION_GROWTH_FACTOR)
                .min(LAST_SLOT_ORDINAL + 1);
            grow_to(&mut self.term_offset, capacity);
            grow_to(&mut self.term_length, capacity);
            grow_to(&mut self.first_unit_next, capacity);
        }
        if units > self.units.len() {
            let capacity = units
                .max(self.units.len() * TERM_REGION_GROWTH_FACTOR)
                .min(LAST_OFFSET);
            grow_to(&mut self.units, capacity);
        }
        let occupied = self.occupied_slots();
        if (occupied + added) * TERM_SLOT_LOAD_DENOMINATOR
            >= self.slots.len() * TERM_SLOT_LOAD_NUMERATOR
        {
            let capacity = slots_holding(self.live_count() + added)?.max(self.slots.len());
            self.rehash(capacity);
        }
        Ok(())
    }

    pub(crate) fn grow(&mut self) -> Result<()> {
        let terms = (self.capacity() * TERM_REGION_GROWTH_FACTOR).max(self.count() + 1);
        let units = (self.units.len() * TERM_REGION_GROWTH_FACTOR).min(LAST_OFFSET);
        self.reserve(terms, units)?;
        let capacity =
            slots_holding(self.live_count() + 1)?.max(self.slots.len() * TERM_REGION_GROWTH_FACTOR);
        if capacity > LAST_SLOT_CAPACITY {
            return Err(region_full("hash slots"));
        }
        self.rehash(capacity);
        Ok(())
    }

    fn rehash(&mut self, capacity: usize) {
        let mut slots = vec![0i32; capacity];
        let mask = capacity - 1;
        for &entry in &self.slots {
            if entry <= 0 {
                continue;
            }
            let mut slot = term_hash(self.text(entry as usize - 1)) as usize & mask;
            while slots[slot] != 0 {
                slot = (slot + 1) & mask;
            }
            slots[slot] = entry;
        }
        self.slots = slots;
        self.header[SLOT_CAPACITY] = capacity as u32;
        self.occupied = self.live_count();
        self.accounted_count = self.count();
    }

    pub(crate) fn raw(&mut self) -> ffi::narsil_term_table {
        ffi::narsil_term_table {
            header: self.header.as_mut_ptr(),
            header_words: HEADER_WORDS,
            slots: self.slots.as_mut_ptr(),
            slot_count: self.slots.len(),
            term_offset: self.term_offset.as_mut_ptr(),
            offset_count: self.term_offset.len(),
            term_length: self.term_length.as_mut_ptr(),
            length_count: self.term_length.len(),
            first_unit_next: self.first_unit_next.as_mut_ptr(),
            next_count: self.first_unit_next.len(),
            first_unit_head: self.first_unit_head.as_mut_ptr(),
            head_count: self.first_unit_head.len(),
            units: self.units.as_mut_ptr(),
            unit_count: self.units.len(),
        }
    }

    pub(crate) fn view(&self) -> ffi::narsil_term_table {
        ffi::narsil_term_table {
            header: self.header.as_ptr().cast_mut(),
            header_words: HEADER_WORDS,
            slots: self.slots.as_ptr().cast_mut(),
            slot_count: self.slots.len(),
            term_offset: self.term_offset.as_ptr().cast_mut(),
            offset_count: self.term_offset.len(),
            term_length: self.term_length.as_ptr().cast_mut(),
            length_count: self.term_length.len(),
            first_unit_next: self.first_unit_next.as_ptr().cast_mut(),
            next_count: self.first_unit_next.len(),
            first_unit_head: self.first_unit_head.as_ptr().cast_mut(),
            head_count: self.first_unit_head.len(),
            units: self.units.as_ptr().cast_mut(),
            unit_count: self.units.len(),
        }
    }

    pub(crate) fn bytes(&self) -> usize {
        HEADER_WORDS * 4
            + self.slots.len() * 4
            + (self.term_offset.len() + self.term_length.len() + self.first_unit_next.len()) * 4
            + self.first_unit_head.len() * 4
            + self.units.len() * 2
    }
}
