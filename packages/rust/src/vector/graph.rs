use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU8, Ordering};

use crate::ffi;

use crate::pins::{MAX_THREAD_SLOTS, slots_reached};

use super::constants::{LOCK_SPIN_ITERATIONS, MIN_ORDINAL_CAPACITY, MIN_UPPER_WORDS};
use super::region::{
    byte_ptr, bytes, copied_bytes, copied_words, load, load_byte, store, word_ptr, words,
    zeroed_words,
};

const GRAPH_WORD_METRIC: usize = 5;
const NO_NODE: i32 = -1;
const HELD_ALONE: i32 = -1;
const LOCK_FREE: i32 = 0;

pub(crate) struct GraphTables {
    pub(crate) m: u32,
    pub(crate) ef_construction: u32,
    pub(crate) metric: u32,
    slot_capacity: usize,
    header: Box<[AtomicI32]>,
    node_levels: Box<[AtomicU8]>,
    level0: Box<[AtomicI32]>,
    upper_base: Box<[AtomicI32]>,
    upper: Box<[AtomicI32]>,
    locks: Box<[AtomicI32]>,
    tombstones: Box<[AtomicU8]>,
    incoming: Box<[AtomicI32]>,
    nearest_link_due: Box<[AtomicU8]>,
    held: Box<[AtomicI32]>,
    incoming_uncounted: AtomicBool,
}

pub(crate) struct HeldAlone<'a> {
    graph: &'a GraphTables,
}

impl Drop for HeldAlone<'_> {
    fn drop(&mut self) {
        self.graph.header[ffi::NARSIL_GRAPH_WORD_LOCK].store(LOCK_FREE, Ordering::Release);
    }
}

pub(crate) fn upper_words_of(m: u32, top_layer: u8) -> usize {
    usize::from(top_layer) * (m as usize + ffi::NARSIL_LIST_WORDS_OVER_NEIGHBOURS)
}

impl GraphTables {
    pub(crate) fn new(
        m: u32,
        ef_construction: u32,
        metric: u32,
        slots: usize,
        upper: usize,
    ) -> Self {
        let slot_capacity = slots.max(MIN_ORDINAL_CAPACITY);
        let upper_capacity = upper.max(MIN_UPPER_WORDS);
        let stride = 2 * m as usize + ffi::NARSIL_LIST_WORDS_OVER_NEIGHBOURS;
        let graph = GraphTables {
            m,
            ef_construction,
            metric,
            slot_capacity,
            header: words(ffi::NARSIL_GRAPH_HEADER_WORDS, 0),
            node_levels: bytes(slot_capacity),
            level0: words(slot_capacity * stride, 0),
            upper_base: words(slot_capacity, 0),
            upper: words(upper_capacity, 0),
            locks: words(slot_capacity, 0),
            tombstones: bytes(slot_capacity),
            incoming: words(slot_capacity, 0),
            nearest_link_due: bytes(slot_capacity),
            held: zeroed_words(MAX_THREAD_SLOTS as usize * ffi::NARSIL_HELD_WORDS_PER_THREAD),
            incoming_uncounted: AtomicBool::new(false),
        };
        graph.set_word(ffi::NARSIL_GRAPH_WORD_ENTRY_POINT, NO_NODE);
        graph.set_word(ffi::NARSIL_GRAPH_WORD_TOP_LAYER, NO_NODE);
        graph.set_word(ffi::NARSIL_GRAPH_WORD_M, m as i32);
        graph.set_word(ffi::NARSIL_GRAPH_WORD_MMAX0, 2 * m as i32);
        graph.set_word(
            ffi::NARSIL_GRAPH_WORD_EF_CONSTRUCTION,
            ef_construction as i32,
        );
        graph.set_word(GRAPH_WORD_METRIC, metric as i32);
        graph.set_word(ffi::NARSIL_GRAPH_WORD_SLOT_CAPACITY, slot_capacity as i32);
        graph.set_word(ffi::NARSIL_GRAPH_WORD_UPPER_CAPACITY, upper_capacity as i32);
        graph
    }

    pub(crate) fn copied(&self, slots: usize, upper: usize) -> GraphTables {
        let slot_capacity = slots.max(self.slot_capacity);
        let upper_capacity = upper.max(self.upper.len());
        let stride = self.base_stride();
        let header = copied_words(&self.header, self.header.len(), 0);
        for word in [
            ffi::NARSIL_GRAPH_WORD_LOCK,
            ffi::NARSIL_GRAPH_WORD_WRITERS_WAITING,
            ffi::NARSIL_GRAPH_WORD_ENTRY_LOCK,
        ] {
            store(&header, word, LOCK_FREE);
        }
        store(
            &header,
            ffi::NARSIL_GRAPH_WORD_SLOT_CAPACITY,
            slot_capacity as i32,
        );
        store(
            &header,
            ffi::NARSIL_GRAPH_WORD_UPPER_CAPACITY,
            upper_capacity as i32,
        );
        let unlocked: Box<[AtomicI32]> = self
            .locks
            .iter()
            .map(|word| word.load(Ordering::Acquire) & !3)
            .chain(std::iter::repeat(0))
            .take(slot_capacity)
            .map(AtomicI32::new)
            .collect();
        GraphTables {
            m: self.m,
            ef_construction: self.ef_construction,
            metric: self.metric,
            slot_capacity,
            header,
            node_levels: copied_bytes(&self.node_levels, slot_capacity),
            level0: copied_words(&self.level0, slot_capacity * stride, 0),
            upper_base: copied_words(&self.upper_base, slot_capacity, 0),
            upper: copied_words(&self.upper, upper_capacity, 0),
            locks: unlocked,
            tombstones: copied_bytes(&self.tombstones, slot_capacity),
            incoming: copied_words(&self.incoming, slot_capacity, 0),
            nearest_link_due: copied_bytes(&self.nearest_link_due, slot_capacity),
            held: zeroed_words(self.held.len()),
            incoming_uncounted: AtomicBool::new(self.incoming_uncounted.load(Ordering::Acquire)),
        }
    }

    pub(crate) fn raw(&self) -> ffi::narsil_graph {
        ffi::narsil_graph {
            header: word_ptr(&self.header),
            node_levels: byte_ptr(&self.node_levels),
            level0: word_ptr(&self.level0),
            upper_base: word_ptr(&self.upper_base),
            upper: word_ptr(&self.upper),
            locks: word_ptr(&self.locks),
            tombstones: byte_ptr(&self.tombstones),
            incoming: word_ptr(&self.incoming),
            nearest_link_due: byte_ptr(&self.nearest_link_due),
            held_locks: word_ptr(&self.held),
            thread_slots: slots_reached().min(MAX_THREAD_SLOTS),
            wake: None,
            wake_context: std::ptr::null_mut(),
        }
    }

    pub(crate) fn word(&self, at: usize) -> i32 {
        load(&self.header, at)
    }

    pub(crate) fn set_word(&self, at: usize, value: i32) {
        store(&self.header, at, value);
    }

    fn base_stride(&self) -> usize {
        2 * self.m as usize + ffi::NARSIL_LIST_WORDS_OVER_NEIGHBOURS
    }

    fn upper_stride(&self) -> usize {
        self.m as usize + ffi::NARSIL_LIST_WORDS_OVER_NEIGHBOURS
    }

    pub(crate) fn slot_capacity(&self) -> usize {
        self.slot_capacity
    }

    pub(crate) fn upper_capacity(&self) -> usize {
        self.upper.len()
    }

    pub(crate) fn upper_used(&self) -> usize {
        self.word(ffi::NARSIL_GRAPH_WORD_UPPER_USED).max(0) as usize
    }

    pub(crate) fn slots(&self) -> u32 {
        (self.word(ffi::NARSIL_GRAPH_WORD_SLOTS).max(0) as u32).min(self.slot_capacity as u32)
    }

    pub(crate) fn entry_point(&self) -> Option<u32> {
        u32::try_from(self.word(ffi::NARSIL_GRAPH_WORD_ENTRY_POINT)).ok()
    }

    pub(crate) fn top_layer(&self) -> i32 {
        self.word(ffi::NARSIL_GRAPH_WORD_TOP_LAYER)
    }

    fn node_count(&self) -> u64 {
        self.word(ffi::NARSIL_GRAPH_WORD_NODE_COUNT).max(0) as u64
    }

    pub(crate) fn tombstone_count(&self) -> u64 {
        self.word(ffi::NARSIL_GRAPH_WORD_TOMBSTONE_COUNT).max(0) as u64
    }

    pub(crate) fn size(&self) -> u64 {
        self.node_count().saturating_sub(self.tombstone_count())
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entry_point().is_none() || self.size() == 0
    }

    pub(crate) fn level(&self, ordinal: u32) -> u8 {
        load_byte(&self.node_levels, ordinal as usize)
    }

    pub(crate) fn holds_node(&self, ordinal: u32) -> bool {
        self.level(ordinal) > 0
    }

    pub(crate) fn holds_tombstone(&self, ordinal: u32) -> bool {
        self.holds_node(ordinal) && load_byte(&self.tombstones, ordinal as usize) == 1
    }

    pub(crate) fn holds_live_node(&self, ordinal: u32) -> bool {
        self.holds_node(ordinal) && load_byte(&self.tombstones, ordinal as usize) == 0
    }

    pub(crate) fn list(&self, ordinal: u32, layer: u8, out: &mut Vec<u32>) {
        out.clear();
        let level = self.level(ordinal);
        if layer >= level {
            return;
        }
        let (start, limit) = if layer == 0 {
            (ordinal as usize * self.base_stride(), 2 * self.m as usize)
        } else {
            let base = load(&self.upper_base, ordinal as usize);
            if base <= 0 {
                return;
            }
            let start = (base - 1) as usize + (usize::from(layer) - 1) * self.upper_stride();
            if start + self.upper_stride() > self.upper_used() {
                return;
            }
            (start, self.m as usize)
        };
        let region = if layer == 0 {
            &self.level0
        } else {
            &self.upper
        };
        let count = (load(region, start).max(0) as usize).min(limit);
        for at in 1..=count {
            if let Ok(neighbour) = u32::try_from(load(region, start + at)) {
                out.push(neighbour);
            }
        }
    }

    pub(crate) fn hold_alone(&self) -> HeldAlone<'_> {
        let waiting = &self.header[ffi::NARSIL_GRAPH_WORD_WRITERS_WAITING];
        let lock = &self.header[ffi::NARSIL_GRAPH_WORD_LOCK];
        waiting.fetch_add(1, Ordering::AcqRel);
        let mut spins = 0;
        while lock
            .compare_exchange(LOCK_FREE, HELD_ALONE, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            if spins < LOCK_SPIN_ITERATIONS {
                spins += 1;
                std::hint::spin_loop();
            } else {
                std::thread::yield_now();
            }
        }
        waiting.fetch_sub(1, Ordering::AcqRel);
        HeldAlone { graph: self }
    }

    pub(crate) fn leave_incoming_uncounted(&self) {
        self.set_word(ffi::NARSIL_GRAPH_WORD_UNLINKED_NODES, 0);
        self.incoming_uncounted.store(true, Ordering::Release);
    }

    pub(crate) fn incoming_uncounted(&self) -> bool {
        self.incoming_uncounted.load(Ordering::Acquire)
    }

    pub(crate) fn count_incoming(&self) -> bool {
        let slots = self.slots();
        for word in self.incoming.iter() {
            word.store(0, Ordering::Relaxed);
        }
        let mut list = Vec::new();
        for ordinal in 0..slots {
            self.list(ordinal, 0, &mut list);
            for &neighbour in &list {
                if neighbour != ordinal && neighbour < slots && self.holds_node(neighbour) {
                    self.incoming[neighbour as usize].fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        self.incoming_uncounted.store(false, Ordering::Release);
        let entry = self.entry_point();
        (0..slots).any(|ordinal| {
            Some(ordinal) != entry
                && self.holds_live_node(ordinal)
                && load(&self.incoming, ordinal as usize) == 0
        })
    }

    pub(crate) fn mark_tombstone_directly(&self, ordinal: u32) {
        if !self.holds_node(ordinal) {
            return;
        }
        if let Some(byte) = self.tombstones.get(ordinal as usize)
            && byte.swap(1, Ordering::AcqRel) == 0
        {
            self.header[ffi::NARSIL_GRAPH_WORD_TOMBSTONE_COUNT].fetch_add(1, Ordering::AcqRel);
        }
    }

    pub(crate) fn restore_node(&self, ordinal: u32, top_layer: u8, lists: &[Vec<u32>]) -> bool {
        let at = ordinal as usize;
        if at >= self.slot_capacity || self.holds_node(ordinal) {
            return false;
        }
        let upper = upper_words_of(self.m, top_layer);
        let used = self.upper_used();
        if used + upper > self.upper.len() {
            return false;
        }
        store(
            &self.upper_base,
            at,
            if upper == 0 { 0 } else { used as i32 + 1 },
        );
        self.set_word(ffi::NARSIL_GRAPH_WORD_UPPER_USED, (used + upper) as i32);
        for (layer, list) in lists.iter().enumerate().take(usize::from(top_layer) + 1) {
            let (region, start, limit) = if layer == 0 {
                (&self.level0, at * self.base_stride(), 2 * self.m as usize)
            } else {
                (
                    &self.upper,
                    used + (layer - 1) * self.upper_stride(),
                    self.m as usize,
                )
            };
            let count = list.len().min(limit);
            store(region, start, count as i32);
            for (offset, &neighbour) in list.iter().take(count).enumerate() {
                store(region, start + 1 + offset, neighbour as i32);
            }
        }
        let slots = self.word(ffi::NARSIL_GRAPH_WORD_SLOTS).max(0) as usize;
        if at + 1 > slots {
            self.set_word(ffi::NARSIL_GRAPH_WORD_SLOTS, at as i32 + 1);
        }
        self.node_levels[at].store(top_layer + 1, Ordering::Release);
        self.header[ffi::NARSIL_GRAPH_WORD_NODE_COUNT].fetch_add(1, Ordering::AcqRel);
        true
    }

    pub(crate) fn set_entry(&self, ordinal: Option<u32>, top_layer: i32) {
        self.set_word(
            ffi::NARSIL_GRAPH_WORD_ENTRY_POINT,
            ordinal.map_or(NO_NODE, |found| found as i32),
        );
        self.set_word(ffi::NARSIL_GRAPH_WORD_TOP_LAYER, top_layer);
    }

    pub(crate) fn memory_bytes(&self) -> usize {
        self.slot_capacity * (1 + self.base_stride() * 4 + 4 + 4 + 1 + 4 + 1)
            + self.upper.len() * 4
            + slots_reached() as usize * ffi::NARSIL_HELD_WORDS_PER_THREAD * 4
            + self.header.len() * 4
    }
}
