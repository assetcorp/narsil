use std::collections::BTreeMap;
use std::sync::{Arc, RwLock, RwLockWriteGuard};

use super::frozen::FrozenSegment;
use super::indexed::IndexedDocument;
use super::segment::{SegmentData, SegmentEntry};
use super::tail::{Appended, TailSegment};

pub(crate) type Freeze<'a> = dyn Fn(&SegmentEntry) -> Result<FrozenSegment> + 'a;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::Map;

/// The document count and the summed field lengths of a partition's live documents.
#[derive(Clone, Default, Debug)]
pub(crate) struct PartitionStats {
    pub(crate) documents: u64,
    pub(crate) field_totals: BTreeMap<String, f64>,
}

impl PartitionStats {
    pub(crate) fn add(&mut self, field_lengths: impl IntoIterator<Item = (String, u32)>) {
        self.documents += 1;
        for (field, length) in field_lengths {
            *self.field_totals.entry(field).or_insert(0.0) += length as f64;
        }
    }

    pub(crate) fn subtract(&mut self, field_lengths: impl IntoIterator<Item = (String, u32)>) {
        if self.documents == 0 {
            return;
        }
        self.documents -= 1;
        for (field, length) in field_lengths {
            if let Some(total) = self.field_totals.get_mut(&field) {
                *total -= length as f64;
                if *total <= 0.0 {
                    self.field_totals.remove(&field);
                }
            }
        }
    }
}

/// Everything a search reads from one partition at one moment.
#[derive(Clone)]
pub(crate) struct PartitionSnapshot {
    pub(crate) segments: Vec<SegmentEntry>,
    pub(crate) stats: PartitionStats,
    pub(crate) next_segment_id: u64,
    pub(crate) track_positions: bool,
}

impl PartitionSnapshot {
    pub(crate) fn new(track_positions: bool) -> PartitionSnapshot {
        PartitionSnapshot {
            segments: Vec::new(),
            stats: PartitionStats::default(),
            next_segment_id: 0,
            track_positions,
        }
    }

    pub(crate) fn document_count(&self) -> u64 {
        self.stats.documents
    }

    /// Finds the live copy of a document, newest segment first.
    pub(crate) fn locate(&self, id: &str) -> Result<Option<(usize, u32)>> {
        for (at, entry) in self.segments.iter().enumerate().rev() {
            if let Some(ordinal) = entry.ordinal_of(id)? {
                return Ok(Some((at, ordinal)));
            }
        }
        Ok(None)
    }

    pub(crate) fn has(&self, id: &str) -> Result<bool> {
        Ok(self.locate(id)?.is_some())
    }

    /// Returns the stored form of the live copy of a document, raising the error of a segment that cannot read it.
    pub(crate) fn document(&self, id: &str) -> Result<Option<Arc<Map>>> {
        let Some((at, ordinal)) = self.locate(id)? else {
            return Ok(None);
        };
        self.segments[at].document(ordinal).map(Some)
    }

    pub(crate) fn allocate_segment_id(&mut self) -> u64 {
        let id = self.next_segment_id;
        self.next_segment_id += 1;
        id
    }

    fn writable_tail(&mut self) -> Option<&mut TailSegment> {
        let reusable = match self.segments.last_mut().map(|entry| &mut entry.data) {
            Some(SegmentData::Tail(tail)) => Arc::get_mut(tail).is_some(),
            _ => false,
        };
        if !reusable {
            let id = self.allocate_segment_id();
            let tail = TailSegment::new(self.track_positions);
            self.segments
                .push(SegmentEntry::new(id, SegmentData::Tail(Arc::new(tail))));
        }
        match &mut self.segments.last_mut()?.data {
            SegmentData::Tail(tail) => Arc::get_mut(tail),
            SegmentData::Frozen(_) => None,
        }
    }

    fn freeze_tail(&mut self, freeze: &Freeze<'_>) -> Result<()> {
        let Some(entry) = self.segments.last_mut() else {
            return Ok(());
        };
        if !matches!(entry.data, SegmentData::Tail(_)) {
            return Ok(());
        }
        let frozen = freeze(entry)?;
        *entry = SegmentEntry::new(entry.id, SegmentData::Frozen(Arc::new(frozen)));
        Ok(())
    }

    pub(crate) fn append(
        &mut self,
        id: String,
        document: Arc<Map>,
        indexed: IndexedDocument,
        freeze: &Freeze<'_>,
    ) -> Result<()> {
        let lengths: Vec<(String, u32)> = indexed
            .text
            .iter()
            .map(|field| (field.path.clone(), field.length))
            .collect();
        let mut pending = indexed;
        for attempt in 0..2 {
            let Some(tail) = self.writable_tail() else {
                return Err(NarsilError::new(
                    ErrorCode::PARTITION_CORRUPTED,
                    "The partition holds no writable tail segment",
                ));
            };
            match tail.append(id.clone(), Arc::clone(&document), pending)? {
                Appended::Stored => {
                    self.stats.add(lengths);
                    return Ok(());
                }
                Appended::SegmentFull(_) if attempt == 1 => break,
                Appended::SegmentFull(returned) => {
                    pending = returned;
                    self.freeze_tail(freeze)?;
                }
            }
        }
        Err(NarsilError::new(
            ErrorCode::PARTITION_CORRUPTED,
            "A document's surface or spelling counts do not fit even an empty keyword segment",
        ))
    }

    pub(crate) fn remove(
        &mut self,
        id: &str,
        analyse: &dyn Fn(&Map) -> Result<IndexedDocument>,
    ) -> Result<Option<Arc<Map>>> {
        let Some((at, ordinal)) = self.locate(id)? else {
            return Ok(None);
        };
        let entry = &mut self.segments[at];
        let document = entry.document(ordinal)?;
        let words = analyse(&document)?;
        if !entry.remove(ordinal, &words)? {
            return Ok(None);
        }
        self.stats.subtract(
            words
                .text
                .iter()
                .map(|field| (field.path.clone(), field.length)),
        );
        Ok(Some(document))
    }

    pub(crate) fn clear(&mut self) {
        self.segments.clear();
        self.stats = PartitionStats::default();
    }
}

/// One partition, shared by every thread: searches clone the published snapshot under a read lock, so that no
/// search waits for another, and the one writer of the index applies each change in place under the write lock
/// while no search holds the snapshot, or to a copy that it then publishes.
pub(crate) struct Partition {
    published: RwLock<Arc<PartitionSnapshot>>,
}

fn published<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Partition {
    pub(crate) fn new(snapshot: PartitionSnapshot) -> Partition {
        Partition {
            published: RwLock::new(Arc::new(snapshot)),
        }
    }

    pub(crate) fn snapshot(&self) -> Arc<PartitionSnapshot> {
        self.published
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Applies a change; the writer of the index must hold its write lock, so that changes never interleave.
    pub(crate) fn write<R>(&self, apply: impl FnOnce(&mut PartitionSnapshot) -> R) -> R {
        let mut guard = published(&self.published);
        if let Some(snapshot) = Arc::get_mut(&mut guard) {
            return apply(snapshot);
        }
        let mut copy = PartitionSnapshot::clone(&guard);
        drop(guard);
        let result = apply(&mut copy);
        *published(&self.published) = Arc::new(copy);
        result
    }
}
