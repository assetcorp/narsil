use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::ptr;
use std::sync::Arc;

use super::lists::{PostingList, PostingPositions};
use super::page_cache::{PageCache, page_slots_within, slot_bytes};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::index::constants::{LARGEST_CACHED_ENTRY_PARTS, THREAD_READ_CACHE_BYTES};

/// What a thread's read cache holds for one paged segment file, each checked once as it entered the cache.
#[derive(Clone)]
pub(crate) enum Cached {
    Page(Arc<Vec<u8>>),
    List(Arc<PostingList>),
    Positions(Arc<PostingPositions>),
    Block(Arc<super::documents::DocumentBlock>),
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) enum Kind {
    Page,
    List,
    Positions,
    Block,
}

type Key = (u64, Kind, u64);

struct Entry {
    value: Cached,
    bytes: usize,
    tick: u64,
}

/// A least recently used cache of pages and decoded lists, one for each thread that reads paged segments, so that
/// one thread alone writes each cache and the bytes it holds stay below its capacity.
struct ReadCache {
    capacity: usize,
    held: usize,
    tick: u64,
    entries: HashMap<Key, Entry>,
    order: BTreeMap<u64, Key>,
    page_slots: usize,
    pages: Option<PageCache>,
}

impl ReadCache {
    fn get(&mut self, key: Key) -> Option<Cached> {
        self.tick += 1;
        let tick = self.tick;
        let entry = self.entries.get_mut(&key)?;
        self.order.remove(&entry.tick);
        entry.tick = tick;
        self.order.insert(tick, key);
        Some(entry.value.clone())
    }

    fn drop_entry(&mut self, key: &Key) {
        if let Some(entry) = self.entries.remove(key) {
            self.order.remove(&entry.tick);
            self.held -= entry.bytes;
        }
    }

    fn put(&mut self, key: Key, value: Cached, bytes: usize) {
        if bytes > self.capacity / LARGEST_CACHED_ENTRY_PARTS {
            return;
        }
        self.drop_entry(&key);
        self.tick += 1;
        self.entries.insert(
            key,
            Entry {
                value,
                bytes,
                tick: self.tick,
            },
        );
        self.order.insert(self.tick, key);
        self.held += bytes;
        while self.held > self.capacity {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.held -= entry.bytes;
            }
        }
    }

    fn release_file(&mut self, file: u64) {
        let keys: Vec<Key> = self
            .entries
            .keys()
            .filter(|key| key.0 == file)
            .copied()
            .collect();
        for key in keys {
            self.drop_entry(&key);
        }
    }
}

impl ReadCache {
    fn with_capacity(capacity: usize) -> ReadCache {
        let page_slots = page_slots_within(capacity);
        ReadCache {
            capacity: capacity.saturating_sub(page_slots * slot_bytes()),
            held: 0,
            tick: 0,
            entries: HashMap::new(),
            order: BTreeMap::new(),
            page_slots,
            pages: None,
        }
    }
}

thread_local! {
    static CACHE: RefCell<ReadCache> = RefCell::new(ReadCache::with_capacity(THREAD_READ_CACHE_BYTES));
}

/// Holds the thread's read cache aside while a merge reads through a separate cache, and puts it back on drop.
pub(crate) struct MergeCacheScope {
    held_aside: Option<ReadCache>,
}

/// Points this thread's paged reads at a fresh cache of `capacity` bytes until the returned scope drops, so that a
/// merge reads every input through a cache of that size and leaves the cache that searches use as it was.
pub(crate) fn merge_cache_scope(capacity: usize) -> MergeCacheScope {
    let held_aside = CACHE
        .try_with(|cache| {
            let mut current = cache.try_borrow_mut().ok()?;
            Some(std::mem::replace(
                &mut *current,
                ReadCache::with_capacity(capacity),
            ))
        })
        .ok()
        .flatten();
    MergeCacheScope { held_aside }
}

impl Drop for MergeCacheScope {
    fn drop(&mut self) {
        let Some(previous) = self.held_aside.take() else {
            return;
        };
        let _ = CACHE.try_with(|cache| {
            if let Ok(mut current) = cache.try_borrow_mut() {
                *current = previous;
            }
        });
    }
}

pub(crate) fn cached(file: u64, kind: Kind, entry: u64) -> Option<Cached> {
    CACHE.with(|cache| cache.borrow_mut().get((file, kind, entry)))
}

pub(crate) fn remember(file: u64, kind: Kind, entry: u64, value: Cached, bytes: usize) {
    CACHE.with(|cache| cache.borrow_mut().put((file, kind, entry), value, bytes));
}

pub(crate) fn with_page_cache<T>(
    read: impl FnOnce(*mut ffi::narsil_page_cache) -> Result<T>,
) -> Result<T> {
    let mut pending = Some(read);
    let mut result = None;
    let _ = CACHE.try_with(|cache| {
        let Ok(mut held) = cache.try_borrow_mut() else {
            return;
        };
        let Some(read) = pending.take() else {
            return;
        };
        let slots = held.page_slots;
        let mut raw = held
            .pages
            .get_or_insert_with(|| PageCache::with_slots(slots))
            .raw();
        result = Some(read(&mut raw));
    });
    if let Some(read) = pending.take() {
        return read(ptr::null_mut());
    }
    match result {
        Some(result) => result,
        None => Err(NarsilError::new(
            ErrorCode::INTERNAL_ERROR,
            "A paged read lost its page cache",
        )),
    }
}

pub(crate) fn release(file: u64, identity: u64) {
    let _ = CACHE.try_with(|cache| {
        if let Ok(mut cache) = cache.try_borrow_mut() {
            cache.release_file(file);
            if let Some(pages) = cache.pages.as_mut() {
                pages.release(identity);
            }
        }
    });
}
