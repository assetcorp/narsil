use std::collections::HashMap;
use std::hash::RandomState;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, RwLock};

use crate::error::Result;
use crate::pins::IndexSequence;

use super::build::BuildJob;
use super::checkpoint::{FieldSignature, SavedVectorFile};
use super::constants::MIN_ORDINAL_CAPACITY;
use super::doc_ids::{IdTable, OrdinalNames};
use super::graph::GraphTables;
use super::settings::{VectorSettings, require_dimension};
use super::store::{FLAG_BUFFERED, StoreTables};
use super::writes::graphs_of;

pub(crate) const NO_DRIFT_CHECK: u64 = u64::MAX;

#[derive(Default)]
pub(crate) struct Counts {
    pub(crate) held: AtomicU64,
    pub(crate) removed: AtomicU64,
    pub(crate) buffered: AtomicU64,
    pub(crate) replaced: AtomicU64,
}

impl Counts {
    pub(crate) fn live(&self) -> u64 {
        self.held
            .load(Ordering::Acquire)
            .saturating_sub(self.removed.load(Ordering::Acquire))
    }

    pub(crate) fn add(counter: &AtomicU64, step: i64) {
        if step >= 0 {
            counter.fetch_add(step as u64, Ordering::AcqRel);
        } else {
            let mut seen = counter.load(Ordering::Acquire);
            while let Err(now) = counter.compare_exchange_weak(
                seen,
                seen.saturating_sub(step.unsigned_abs()),
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                seen = now;
            }
        }
    }
}

pub(crate) struct BufferList {
    ordinals: Box<[AtomicU32]>,
    len: AtomicUsize,
}

impl BufferList {
    pub(crate) fn with_capacity(capacity: usize) -> BufferList {
        BufferList {
            ordinals: (0..capacity.max(MIN_ORDINAL_CAPACITY))
                .map(|_| AtomicU32::new(0))
                .collect(),
            len: AtomicUsize::new(0),
        }
    }

    pub(crate) fn push(&self, ordinal: u32) -> bool {
        let at = self.len.load(Ordering::Acquire);
        let Some(slot) = self.ordinals.get(at) else {
            return false;
        };
        slot.store(ordinal, Ordering::Release);
        self.len.store(at + 1, Ordering::Release);
        true
    }

    pub(crate) fn len(&self) -> usize {
        self.len.load(Ordering::Acquire)
    }

    pub(crate) fn capacity(&self) -> usize {
        self.ordinals.len()
    }

    pub(crate) fn ordinals(&self) -> impl Iterator<Item = u32> + '_ {
        self.ordinals[..self.len().min(self.ordinals.len())]
            .iter()
            .map(|slot| slot.load(Ordering::Acquire))
    }
}

pub(crate) struct Generation {
    pub(crate) store: Arc<StoreTables>,
    pub(crate) graph: Option<Arc<GraphTables>>,
    pub(crate) names: Arc<OrdinalNames>,
    pub(crate) ids: Arc<IdTable>,
    pub(crate) buffer: Arc<BufferList>,
    pub(crate) counts: Arc<Counts>,
}

impl Generation {
    pub(crate) fn empty(
        settings: &VectorSettings,
        hasher: RandomState,
        sequence: &Arc<IndexSequence>,
    ) -> Generation {
        Generation {
            store: Arc::new(StoreTables::new(
                settings.dimension,
                settings.bits(),
                MIN_ORDINAL_CAPACITY,
                Some(Arc::clone(sequence)),
            )),
            graph: None,
            names: Arc::new(OrdinalNames::new()),
            ids: Arc::new(IdTable::for_entries(0, hasher)),
            buffer: Arc::new(BufferList::with_capacity(MIN_ORDINAL_CAPACITY)),
            counts: Arc::new(Counts::default()),
        }
    }

    pub(crate) fn with(&self, change: impl FnOnce(&mut GenerationParts)) -> Generation {
        let mut parts = GenerationParts {
            store: Arc::clone(&self.store),
            graph: self.graph.clone(),
            ids: Arc::clone(&self.ids),
            buffer: Arc::clone(&self.buffer),
        };
        change(&mut parts);
        Generation {
            store: parts.store,
            graph: parts.graph,
            names: Arc::clone(&self.names),
            ids: parts.ids,
            buffer: parts.buffer,
            counts: Arc::clone(&self.counts),
        }
    }

    pub(crate) fn doc_id(&self, ordinal: u32) -> Option<&str> {
        self.names.get(ordinal)
    }

    pub(crate) fn ordinal_of(&self, doc_id: &str) -> Option<u32> {
        self.ids.find(doc_id, &self.names)
    }

    pub(crate) fn live_ordinal_of(&self, doc_id: &str) -> Option<u32> {
        self.ordinal_of(doc_id)
            .filter(|&ordinal| self.store.is_live(ordinal))
    }

    pub(crate) fn live_ordinals(&self) -> Vec<u32> {
        (0..self.store.slots())
            .filter(|&ordinal| self.store.is_live(ordinal))
            .collect()
    }

    pub(crate) fn buffer_capacity(&self) -> usize {
        self.buffer.capacity()
    }

    pub(crate) fn is_buffered(&self, ordinal: u32) -> bool {
        self.store.flags(ordinal) & FLAG_BUFFERED != 0
    }
}

pub(crate) struct GenerationParts {
    pub(crate) store: Arc<StoreTables>,
    pub(crate) graph: Option<Arc<GraphTables>>,
    pub(crate) ids: Arc<IdTable>,
    pub(crate) buffer: Arc<BufferList>,
}

pub(crate) struct Writer {
    pub(crate) generation: Arc<Generation>,
    pub(crate) id_slots_used: usize,
    pub(crate) job: Option<BuildJob>,
    pub(crate) calibrated_count: Option<u64>,
    pub(crate) calibrated_mean_length: Option<f64>,
    pub(crate) revision: u64,
    pub(crate) removed_ordinals: Vec<u32>,
    pub(crate) replaced_ordinals: Vec<u32>,
    pub(crate) saved_files: Vec<SavedVectorFile>,
    pub(crate) saved_signature: Option<FieldSignature>,
    pub(crate) pending_locations: HashMap<u32, (PathBuf, u64)>,
    pub(crate) holds_publication: bool,
    pub(crate) placing: Option<Placing>,
}

/// The ordinals that a build places in `graph` while the writer lock stays free, sorted, so that a write in that
/// time keeps each one's vector and code until the build can tombstone it.
pub(crate) struct Placing {
    pub(crate) graph: Arc<GraphTables>,
    pub(crate) ordinals: Vec<u32>,
}

impl Placing {
    pub(crate) fn of(graph: &Arc<GraphTables>, ordinals: &[u32]) -> Placing {
        let mut sorted = ordinals.to_vec();
        sorted.sort_unstable();
        Placing {
            graph: Arc::clone(graph),
            ordinals: sorted,
        }
    }
}

impl Writer {
    /// Reports whether a build is placing `ordinal` in a graph that this field still holds.
    pub(crate) fn is_placing(&self, ordinal: u32) -> bool {
        self.placing.as_ref().is_some_and(|placing| {
            placing.ordinals.binary_search(&ordinal).is_ok()
                && graphs_of(self)
                    .iter()
                    .any(|graph| Arc::ptr_eq(graph, &placing.graph))
        })
    }
}

pub(crate) struct History {
    pub(crate) shuffled_build_count: AtomicU64,
    pub(crate) next_drift_check_at: AtomicU64,
    pub(crate) compacted_node_count: AtomicU64,
}

pub(crate) const NO_SHUFFLED_BUILD: u64 = u64::MAX;

impl History {
    pub(crate) fn shuffled_build_count(&self) -> Option<u64> {
        let count = self.shuffled_build_count.load(Ordering::Acquire);
        (count != NO_SHUFFLED_BUILD).then_some(count)
    }

    pub(crate) fn set_shuffled_build_count(&self, count: Option<u64>) {
        self.shuffled_build_count
            .store(count.unwrap_or(NO_SHUFFLED_BUILD), Ordering::Release);
    }
}

pub(crate) struct Shared {
    pub(crate) settings: VectorSettings,
    pub(crate) hasher: RandomState,
    pub(crate) sequence: Arc<IndexSequence>,
    pub(crate) published: RwLock<Arc<Generation>>,
    pub(crate) writer: Mutex<Writer>,
    pub(crate) history: History,
    pub(crate) build_gate: Mutex<()>,
    pub(crate) background: Mutex<bool>,
    pub(crate) background_done: Condvar,
    pub(crate) disposed: AtomicBool,
    pub(crate) restoring: AtomicBool,
}

pub(crate) struct VectorField {
    pub(crate) shared: Arc<Shared>,
}

impl Shared {
    pub(crate) fn current(&self) -> Arc<Generation> {
        match self.published.read() {
            Ok(held) => Arc::clone(&held),
            Err(poisoned) => Arc::clone(&poisoned.into_inner()),
        }
    }

    pub(crate) fn lock_writer(&self) -> MutexGuard<'_, Writer> {
        self.writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn publish(&self, writer: &mut Writer, generation: Generation) {
        writer.generation = Arc::new(generation);
        if writer.holds_publication {
            return;
        }
        self.publish_held(writer);
    }

    pub(crate) fn publish_held(&self, writer: &Writer) {
        let mut published = match self.published.write() {
            Ok(held) => held,
            Err(poisoned) => poisoned.into_inner(),
        };
        *published = Arc::clone(&writer.generation);
    }
}

impl VectorField {
    pub(crate) fn new(
        settings: VectorSettings,
        sequence: Arc<IndexSequence>,
    ) -> Result<VectorField> {
        require_dimension(settings.dimension)?;
        let hasher = RandomState::new();
        let generation = Arc::new(Generation::empty(&settings, hasher.clone(), &sequence));
        Ok(VectorField {
            shared: Arc::new(Shared {
                settings,
                hasher,
                sequence,
                published: RwLock::new(Arc::clone(&generation)),
                writer: Mutex::new(Writer {
                    generation,
                    id_slots_used: 0,
                    job: None,
                    calibrated_count: None,
                    calibrated_mean_length: None,
                    revision: 0,
                    removed_ordinals: Vec::new(),
                    replaced_ordinals: Vec::new(),
                    saved_files: Vec::new(),
                    saved_signature: None,
                    pending_locations: HashMap::new(),
                    holds_publication: false,
                    placing: None,
                }),
                history: History {
                    shuffled_build_count: AtomicU64::new(NO_SHUFFLED_BUILD),
                    next_drift_check_at: AtomicU64::new(NO_DRIFT_CHECK),
                    compacted_node_count: AtomicU64::new(0),
                },
                build_gate: Mutex::new(()),
                background: Mutex::new(false),
                background_done: Condvar::new(),
                disposed: AtomicBool::new(false),
                restoring: AtomicBool::new(false),
            }),
        })
    }

    pub(crate) fn dimension(&self) -> usize {
        self.shared.settings.dimension
    }

    pub(crate) fn record_write_sequence(&self, sequence: i64) {
        let writer = self.shared.lock_writer();
        writer.generation.store.record_write_sequence(sequence);
    }

    pub(crate) fn pinned_vector(&self, doc_id: &str, pin: i64) -> Option<Vec<f32>> {
        let generation = self.shared.current();
        let ordinal = generation.pinned_ordinal_of(doc_id, pin)?;
        let retired = generation.store.retired_at(ordinal);
        if retired != 0 && retired <= pin {
            return None;
        }
        let mut vector = vec![0f32; self.dimension()];
        generation
            .store
            .read_vector(ordinal, &mut vector)
            .then_some(vector)
    }

    pub(crate) fn get_vector(&self, doc_id: &str) -> Option<Vec<f32>> {
        let generation = self.shared.current();
        let ordinal = generation.live_ordinal_of(doc_id)?;
        let mut vector = vec![0f32; self.dimension()];
        generation
            .store
            .read_vector(ordinal, &mut vector)
            .then_some(vector)
    }
}

impl Drop for VectorField {
    fn drop(&mut self) {
        self.shared.disposed.store(true, Ordering::Release);
    }
}
