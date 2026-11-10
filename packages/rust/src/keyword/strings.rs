use super::constants::{
    RUN_MEMBER_START_CAPACITY, RUN_TABLE_START_CAPACITY, STRING_TABLE_START_CAPACITY,
    TERM_REGION_GROWTH_FACTOR,
};
use super::slices::{
    MAX_POOL_ENTRIES, SliceAllocator, grow_to, grown_capacity, region_full, trim_to,
};
use super::term_table::{
    COUNT, HEADER_WORDS, SLOT_CAPACITY, TermTable, rehashed_slots, slots_holding,
};
use crate::error::Result;
use crate::ffi;
use crate::util::hash::fnv1a_of;

const RUN_POINTS: usize = 3;
const LAST_RUN_COUNT: usize = 0x7fff_ffff;

#[derive(Clone)]
pub(crate) struct SurfaceTable {
    strings: TermTable,
    token: Vec<u32>,
    count: Vec<u32>,
}

impl SurfaceTable {
    pub(crate) fn new() -> SurfaceTable {
        SurfaceTable {
            strings: TermTable::new(STRING_TABLE_START_CAPACITY),
            token: vec![0; STRING_TABLE_START_CAPACITY],
            count: vec![0; STRING_TABLE_START_CAPACITY],
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.strings.count()
    }

    pub(crate) fn live_len(&self) -> usize {
        self.strings.live_count()
    }

    pub(crate) fn text(&self, entry: usize) -> &[u16] {
        self.strings.text(entry)
    }

    pub(crate) fn token(&self, entry: usize) -> u32 {
        self.token.get(entry).copied().unwrap_or(0)
    }

    pub(crate) fn count(&self, entry: usize) -> u32 {
        self.count.get(entry).copied().unwrap_or(0)
    }

    pub(crate) fn capacity(&self) -> usize {
        self.strings.capacity()
    }

    fn match_capacity(&mut self) {
        let capacity = self.strings.capacity();
        grow_to(&mut self.token, capacity);
        grow_to(&mut self.count, capacity);
    }

    pub(crate) fn reserve(&mut self, entries: usize, units: usize) -> Result<()> {
        self.strings.reserve(entries, units)?;
        self.match_capacity();
        Ok(())
    }

    pub(crate) fn reserve_more(&mut self, entries: usize, units: usize) -> Result<()> {
        let held = self.strings.count();
        let used = self.strings.units_used();
        self.reserve(held + entries, used + units)
    }

    pub(crate) fn grow(&mut self) -> Result<()> {
        self.strings.grow()?;
        self.match_capacity();
        Ok(())
    }

    pub(crate) fn trim(&mut self) {
        let count = STRING_TABLE_START_CAPACITY.max(self.strings.count());
        self.strings.trim(STRING_TABLE_START_CAPACITY);
        trim_to(&mut self.token, count);
        trim_to(&mut self.count, count);
    }

    pub(crate) fn raw(&mut self) -> ffi::narsil_surface_table {
        ffi::narsil_surface_table {
            strings: self.strings.raw(),
            token: self.token.as_mut_ptr(),
            count: self.count.as_mut_ptr(),
            capacity: self.token.len(),
        }
    }

    pub(crate) fn view(&self) -> ffi::narsil_surface_table {
        ffi::narsil_surface_table {
            strings: self.strings.view(),
            token: self.token.as_ptr().cast_mut(),
            count: self.count.as_ptr().cast_mut(),
            capacity: self.token.len(),
        }
    }

    pub(crate) fn bytes(&self) -> usize {
        self.strings.bytes() + (self.token.len() + self.count.len()) * 4
    }
}

fn run_hash(points: &[u32]) -> u32 {
    fnv1a_of(points.iter().flat_map(|point| point.to_le_bytes()))
}

#[derive(Clone)]
struct RunTable {
    header: Box<[u32; HEADER_WORDS]>,
    slots: Vec<i32>,
    runs: Vec<u32>,
    list_start: Vec<u32>,
    list_length: Vec<u32>,
    list_class: Vec<u8>,
    members: Vec<u32>,
    allocator: SliceAllocator,
}

impl RunTable {
    fn new() -> RunTable {
        let slots = RUN_TABLE_START_CAPACITY * TERM_REGION_GROWTH_FACTOR;
        let mut header = Box::new([0u32; HEADER_WORDS]);
        header[SLOT_CAPACITY] = slots as u32;
        RunTable {
            header,
            slots: vec![0; slots],
            runs: vec![0; RUN_TABLE_START_CAPACITY * RUN_POINTS],
            list_start: vec![0; RUN_TABLE_START_CAPACITY],
            list_length: vec![0; RUN_TABLE_START_CAPACITY],
            list_class: vec![0; RUN_TABLE_START_CAPACITY],
            members: vec![0; RUN_MEMBER_START_CAPACITY],
            allocator: SliceAllocator::new(0),
        }
    }

    fn reserve(&mut self, count: usize, members: usize) -> Result<()> {
        if count > LAST_RUN_COUNT {
            return Err(region_full("run table"));
        }
        let slot_capacity = slots_holding(count)?.max(self.slots.len());
        if slot_capacity > self.slots.len() {
            self.rehash(slot_capacity);
        }
        if count > self.list_start.len() {
            let capacity = count
                .max(self.list_start.len() * TERM_REGION_GROWTH_FACTOR)
                .min(LAST_RUN_COUNT);
            grow_to(&mut self.runs, capacity * RUN_POINTS);
            grow_to(&mut self.list_start, capacity);
            grow_to(&mut self.list_length, capacity);
            grow_to(&mut self.list_class, capacity);
        }
        if members > self.members.len() {
            let capacity = grown_capacity(self.members.len(), members, MAX_POOL_ENTRIES)?;
            grow_to(&mut self.members, capacity);
        }
        Ok(())
    }

    fn reserve_more(&mut self, runs: usize, members: usize) -> Result<()> {
        let count = self.header[COUNT] as usize + runs;
        let used = self.allocator.end() + members;
        self.reserve(count, used)
    }

    fn grow(&mut self) -> Result<()> {
        let count = self.header[COUNT] as usize;
        let runs = (self.list_start.len() * TERM_REGION_GROWTH_FACTOR).max(count + 1);
        let members = grown_capacity(self.members.len(), self.members.len() + 1, MAX_POOL_ENTRIES)?;
        self.reserve(runs, members)?;
        let slots = slots_holding(count + 1)?.max(self.slots.len() * TERM_REGION_GROWTH_FACTOR);
        self.rehash(slots);
        Ok(())
    }

    fn trim(&mut self) {
        let count = RUN_TABLE_START_CAPACITY.max(self.header[COUNT] as usize);
        let least = RUN_TABLE_START_CAPACITY * TERM_REGION_GROWTH_FACTOR;
        if let Ok(holding) = slots_holding(count) {
            let capacity = holding.max(least);
            if capacity < self.slots.len() {
                self.rehash(capacity);
            }
        }
        trim_to(&mut self.runs, count * RUN_POINTS);
        trim_to(&mut self.list_start, count);
        trim_to(&mut self.list_length, count);
        trim_to(&mut self.list_class, count);
        let members = RUN_MEMBER_START_CAPACITY.max(self.allocator.end());
        trim_to(&mut self.members, members);
    }

    fn rehash(&mut self, capacity: usize) {
        self.slots = rehashed_slots(&self.slots, capacity, |run| {
            let start = run * RUN_POINTS;
            run_hash(self.runs.get(start..start + RUN_POINTS).unwrap_or_default())
        });
        self.header[SLOT_CAPACITY] = capacity as u32;
    }

    fn raw(&mut self) -> ffi::narsil_run_table {
        ffi::narsil_run_table {
            header: self.header.as_mut_ptr(),
            slots: self.slots.as_mut_ptr(),
            slot_capacity: self.slots.len(),
            runs: self.runs.as_mut_ptr(),
            list_start: self.list_start.as_mut_ptr(),
            list_length: self.list_length.as_mut_ptr(),
            list_class: self.list_class.as_mut_ptr(),
            capacity: self.list_start.len(),
            members: self.members.as_mut_ptr(),
            member_capacity: self.members.len(),
            allocator: self.allocator.raw(),
        }
    }

    fn view(&self) -> ffi::narsil_run_table {
        ffi::narsil_run_table {
            header: self.header.as_ptr().cast_mut(),
            slots: self.slots.as_ptr().cast_mut(),
            slot_capacity: self.slots.len(),
            runs: self.runs.as_ptr().cast_mut(),
            list_start: self.list_start.as_ptr().cast_mut(),
            list_length: self.list_length.as_ptr().cast_mut(),
            list_class: self.list_class.as_ptr().cast_mut(),
            capacity: self.list_start.len(),
            members: self.members.as_ptr().cast_mut(),
            member_capacity: self.members.len(),
            allocator: self.allocator.view(),
        }
    }

    fn bytes(&self) -> usize {
        HEADER_WORDS * 4
            + self.slots.len() * 4
            + (self.runs.len() + self.list_start.len() + self.list_length.len()) * 4
            + self.list_class.len()
            + self.members.len() * 4
            + self.allocator.bytes()
    }
}

#[derive(Clone)]
pub(crate) struct SpellingTable {
    entries: SurfaceTable,
    code_points: Vec<u32>,
    runs: RunTable,
}

impl SpellingTable {
    pub(crate) fn new() -> SpellingTable {
        SpellingTable {
            entries: SurfaceTable::new(),
            code_points: vec![0; STRING_TABLE_START_CAPACITY],
            runs: RunTable::new(),
        }
    }

    pub(crate) fn entries(&self) -> &SurfaceTable {
        &self.entries
    }

    fn match_capacity(&mut self) {
        grow_to(&mut self.code_points, self.entries.capacity());
    }

    pub(crate) fn reserve_more(&mut self, entries: usize, units: usize, runs: usize) -> Result<()> {
        self.entries.reserve_more(entries, units)?;
        self.match_capacity();
        self.runs.reserve_more(runs, runs)
    }

    pub(crate) fn grow(&mut self) -> Result<()> {
        self.entries.grow()?;
        self.match_capacity();
        self.runs.grow()
    }

    pub(crate) fn trim(&mut self) {
        self.entries.trim();
        trim_to(&mut self.code_points, self.entries.capacity());
        self.runs.trim();
    }

    pub(crate) fn raw(&mut self) -> ffi::narsil_spelling_table {
        ffi::narsil_spelling_table {
            entries: self.entries.raw(),
            code_points: self.code_points.as_mut_ptr(),
            runs: self.runs.raw(),
        }
    }

    pub(crate) fn view(&self) -> ffi::narsil_spelling_table {
        ffi::narsil_spelling_table {
            entries: self.entries.view(),
            code_points: self.code_points.as_ptr().cast_mut(),
            runs: self.runs.view(),
        }
    }

    pub(crate) fn bytes(&self) -> usize {
        self.entries.bytes() + self.code_points.len() * 4 + self.runs.bytes()
    }
}
