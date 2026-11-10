use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock, RwLockWriteGuard};

use super::changes::LayoutChanges;
use super::durable::log::IndexLog;
use super::index_lifecycle::residency::IndexResidency;
use super::layout::TextLayout;
use super::query_suggestions::stored_state::SuggestionState;
use super::synonyms::SynonymSet;
use super::vectors::IndexVectors;
use crate::analysis::Analyser;
use crate::config::IndexConfig;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::frozen::FrozenSegment;
use crate::index::indexed::{IndexedDocument, IndexingOptions, index_document};
use crate::index::merge::freeze_segment;
use crate::index::partition::{Partition, PartitionSnapshot};
use crate::index::segment::SegmentEntry;
use crate::pins::Pin;
use crate::schema::CompiledSchema;
use crate::util::hash::fnv1a;
use crate::value::Map;

pub(crate) struct WriteTurn<'a> {
    _lock: MutexGuard<'a, ()>,
    index: &'a IndexState,
}

impl Drop for WriteTurn<'_> {
    fn drop(&mut self) {
        self.index.vectors.publish_writes();
    }
}

/// One index of an engine: its settings and its partitions, which searches read and its one writer changes.
pub(crate) struct IndexState {
    pub(crate) name: String,
    config: RwLock<Arc<IndexConfig>>,
    pub(crate) schema: CompiledSchema,
    pub(crate) track_positions: bool,
    pub(crate) collect_surfaces: bool,
    pub(crate) vectors: IndexVectors,
    text: RwLock<Arc<TextLayout>>,
    writer: Mutex<()>,
    publication: RwLock<()>,
    log: OnceLock<IndexLog>,
    retired: AtomicBool,
    pub(crate) changes: LayoutChanges,
    analysis_stale: AtomicBool,
    suggestions: RwLock<Arc<SuggestionState>>,
    pub(crate) residency: IndexResidency,
}

fn guarded<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read<T: Clone>(lock: &RwLock<T>) -> T {
    lock.read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn replace<T>(lock: &RwLock<T>, value: T) {
    *lock
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = value;
}

impl IndexState {
    pub(crate) fn new(
        name: String,
        config: IndexConfig,
        schema: CompiledSchema,
        analyser: Analyser,
        synonyms: SynonymSet,
        vectors: IndexVectors,
        partition_count: usize,
    ) -> IndexState {
        let track_positions = config.track_positions.unwrap_or(true);
        let collect_surfaces = config.surface_forms != Some(false);
        let partitions = (0..partition_count.max(1))
            .map(|_| Arc::new(Partition::new(PartitionSnapshot::new(track_positions))))
            .collect();
        let text = TextLayout {
            partitions,
            analyser,
            synonyms: Arc::new(synonyms),
        };
        IndexState {
            name,
            config: RwLock::new(Arc::new(config)),
            schema,
            track_positions,
            collect_surfaces,
            vectors,
            text: RwLock::new(Arc::new(text)),
            writer: Mutex::new(()),
            publication: RwLock::new(()),
            log: OnceLock::new(),
            retired: AtomicBool::new(false),
            changes: LayoutChanges::default(),
            analysis_stale: AtomicBool::new(false),
            suggestions: RwLock::new(Arc::new(SuggestionState::default())),
            residency: IndexResidency::default(),
        }
    }

    /// Returns what the index records about popular query suggestions, which stays valid for the caller while a
    /// change replaces it.
    pub(crate) fn suggestion_state(&self) -> Arc<SuggestionState> {
        read(&self.suggestions)
    }

    /// Replaces what the index records about popular query suggestions, while the caller holds the write lock.
    pub(crate) fn replace_suggestion_state(&self, state: SuggestionState) {
        replace(&self.suggestions, Arc::new(state));
    }

    /// Returns the index's settings as they stand, which stay valid for the caller while a change replaces them.
    pub(crate) fn config(&self) -> Arc<IndexConfig> {
        read(&self.config)
    }

    /// Replaces the index's settings, while the caller holds the write lock.
    pub(crate) fn replace_config(&self, config: Arc<IndexConfig>) {
        replace(&self.config, config);
    }

    /// Returns the analysis that writes and searches the index's terms now.
    pub(crate) fn analyser(&self) -> Analyser {
        self.partitions().analyser.clone()
    }

    /// Reports whether the index's terms came from an earlier analysis than its language module produces now.
    pub(crate) fn analysis_stale(&self) -> bool {
        self.analysis_stale.load(Ordering::Acquire)
    }

    pub(crate) fn set_analysis_stale(&self, stale: bool) {
        self.analysis_stale.store(stale, Ordering::Release);
    }

    /// Returns the write-ahead log of a durable index, or `None` for an index that keeps everything in memory.
    pub(crate) fn log(&self) -> Option<&IndexLog> {
        self.log.get()
    }

    pub(crate) fn attach_log(&self, log: IndexLog) {
        let _ = self.log.set(log);
    }

    /// Returns the synonym set as it stands, which stays valid for the caller while an update replaces it.
    pub(crate) fn synonym_set(&self) -> Arc<SynonymSet> {
        Arc::clone(&self.partitions().synonyms)
    }

    pub(crate) fn replace_synonyms(&self, synonyms: SynonymSet) {
        let layout = self.partitions().with_synonyms(synonyms);
        self.publish_layout(Arc::new(layout));
    }

    /// Returns the partitions as they stand, with the analysis and the synonym set that go with them, which stay
    /// valid for the caller while a rebalance or an analysis change replaces them.
    pub(crate) fn partitions(&self) -> Arc<TextLayout> {
        read(&self.text)
    }

    pub(crate) fn replace_partitions(&self, partitions: Vec<Arc<Partition>>) {
        let layout = self.partitions().with_partitions(partitions);
        self.publish_layout(Arc::new(layout));
    }

    /// Replaces the partitions, their analysis, and the synonym set together, while the caller holds the write lock.
    pub(crate) fn replace_layout(&self, layout: TextLayout) {
        self.publish_layout(Arc::new(layout));
    }

    /// Puts back a layout that [`IndexState::partitions`] returned, while the caller holds the write lock.
    pub(crate) fn restore_layout(&self, layout: Arc<TextLayout>) {
        self.publish_layout(layout);
    }

    fn publish_layout(&self, layout: Arc<TextLayout>) {
        let _publishing = self.publication_turn();
        replace(&self.text, layout);
    }

    /// Takes the index's write lock, which every change holds so that changes apply one at a time.
    pub(crate) fn write_lock(&self) -> WriteTurn<'_> {
        WriteTurn {
            _lock: guarded(&self.writer),
            index: self,
        }
    }

    /// Takes the write lock for a document write, refusing the write where a drop, a restore, or a close has taken
    /// the index out of the engine while the write waited, so that no write reaches a log that another index now
    /// owns.
    pub(crate) fn lock_writes(&self) -> Result<WriteTurn<'_>> {
        let writer = self.write_lock();
        if self.retired.load(Ordering::Acquire) {
            return Err(NarsilError::new(
                ErrorCode::INDEX_NOT_FOUND,
                format!(
                    "Index \"{}\" was dropped, replaced, or closed while the write waited, so the write did not apply",
                    self.name
                ),
            ));
        }
        Ok(writer)
    }

    pub(crate) fn read_published<T>(&self, read: impl FnOnce() -> T) -> T {
        let _published = self
            .publication
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        read()
    }

    fn publication_turn(&self) -> RwLockWriteGuard<'_, ()> {
        self.publication
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn publish<T>(&self, write: impl FnOnce() -> Result<T>) -> Result<T> {
        let _publishing = self.publication_turn();
        let written = write()?;
        self.vectors.publish_writes();
        Ok(written)
    }

    pub(crate) fn published_document(&self, id: &str) -> Result<(Option<Arc<Map>>, Pin)> {
        self.read_published(|| {
            let pin = self.vectors.sequence().pin()?;
            let partitions = self.partitions();
            for at in self.routed_first(id, partitions.len()) {
                if let Some(partition) = partitions.get(at)
                    && let Some(stored) = partition.snapshot().document(id)?
                {
                    return Ok((Some(stored), pin));
                }
            }
            Ok((None, pin))
        })
    }

    /// Marks the index as out of the engine, while the caller holds its write lock, so that every later write to
    /// this copy fails.
    pub(crate) fn retire(&self) {
        self.retired.store(true, Ordering::Release);
    }

    /// Reports whether a drop or a restore has taken the index out of the engine.
    pub(crate) fn is_retired(&self) -> bool {
        self.retired.load(Ordering::Acquire)
    }

    pub(crate) fn route(&self, id: &str, partition_count: usize) -> usize {
        if partition_count == 0 {
            return 0;
        }
        fnv1a(id.as_bytes()) as usize % partition_count
    }

    pub(crate) fn routed_first(&self, id: &str, count: usize) -> impl Iterator<Item = usize> {
        let routed = self.route(id, count);
        std::iter::once(routed).chain((0..count).filter(move |&at| at != routed))
    }

    /// Returns the partition that holds `id`, searching each partition in turn.
    pub(crate) fn locate(&self, partitions: &[Arc<Partition>], id: &str) -> Result<Option<usize>> {
        for at in self.routed_first(id, partitions.len()) {
            if let Some(partition) = partitions.get(at)
                && partition.snapshot().has(id)?
            {
                return Ok(Some(at));
            }
        }
        Ok(None)
    }

    /// Returns the document stored under `id` with its vectors put back, as a read or a hit returns it.
    pub(crate) fn full_document(&self, id: &str) -> Result<Option<Map>> {
        let (stored, pin) = self.published_document(id)?;
        let Some(stored) = stored else {
            return Ok(None);
        };
        let mut document = Arc::unwrap_or_clone(stored);
        let vectors = self.vectors.pinned_vectors(id, pin.value())?;
        self.vectors.attach(vectors, &mut document);
        Ok(Some(document))
    }

    pub(crate) fn stored_document(
        &self,
        snapshots: &[Arc<PartitionSnapshot>],
        id: &str,
    ) -> Result<Option<Arc<Map>>> {
        for at in self.routed_first(id, snapshots.len()) {
            if let Some(snapshot) = snapshots.get(at)
                && let Some(stored) = snapshot.document(id)?
            {
                return Ok(Some(stored));
            }
        }
        Ok(None)
    }

    pub(crate) fn document_count(&self) -> u64 {
        self.partitions()
            .iter()
            .map(|partition| partition.snapshot().document_count())
            .sum()
    }

    pub(crate) fn index_document(&self, document: &Map) -> Result<IndexedDocument> {
        index_document(
            document,
            &self.schema,
            &IndexingOptions {
                analyser: &self.partitions().analyser,
                collect_surfaces: self.collect_surfaces,
            },
        )
    }

    pub(crate) fn freeze_entry(&self, entry: &SegmentEntry) -> Result<FrozenSegment> {
        Ok(FrozenSegment::new(freeze_segment(entry, &self.schema)?))
    }

    pub(crate) fn pattern_value_limit(&self) -> usize {
        self.config()
            .pattern_value_limit
            .map_or(crate::schema::DEFAULT_PATTERN_VALUE_LIMIT, |limit| {
                usize::try_from(limit).unwrap_or(usize::MAX)
            })
    }

    pub(crate) fn not_found(&self, id: &str) -> NarsilError {
        NarsilError::new(
            ErrorCode::DOC_NOT_FOUND,
            format!("Document \"{id}\" not found in any partition"),
        )
    }
}
