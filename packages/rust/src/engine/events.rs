use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use super::Narsil;
use super::callback_scope::address_of;
use super::event_hold::{deliver, queue_while_held};
use super::index::IndexState;
use super::query_suggestions::types::{
    QuerySuggestionsBuildPhase, QuerySuggestionsBuildTrigger, QuerySuggestionsWarningReason,
};
use crate::error::NarsilError;

/// The kind of an engine event, which [`Narsil::on`] takes so that a listener hears one kind alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum NarsilEventKind {
    /// A call changed what a read returns from an index.
    Write,
    /// An index finished spreading its documents across a new number of partitions.
    PartitionRebalance,
    /// An index filled the share of its capacity that its `watermark` sets.
    PartitionWatermark,
    /// A rebuild of an index's terms started, completed, or failed.
    AnalysisRebuild,
    /// The rewrite of an index that an earlier release saved started, completed, or failed.
    LayoutUpgrade,
    /// A checkpoint that the engine wrote in the background failed.
    DurabilityError,
    /// A build of popular query suggestions started, completed, failed, or was skipped.
    QuerySuggestionsBuild,
    /// The engine worked around a problem with popular query suggestions, such as a damaged history file.
    QuerySuggestionsWarning,
}

/// The stage that a rebuild or a rewrite has reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WorkStatus {
    /// The work began.
    Started,
    /// The work finished, and its result now answers every search.
    Completed,
    /// The work stopped with an error, and the index kept what it held before.
    Failed,
}

/// The layout of an index that an earlier release saved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EarlierLayout {
    /// A segment manifest with its files.
    Manifest,
    /// A single snapshot bundle.
    Bundle,
}

/// What the engine reports to the listeners that [`Narsil::on`] registers.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum NarsilEvent {
    /// A call changed what a read returns from `index_name`, once a search can see the change. The engine raises
    /// it after a call that fails as well, because such a call can change the index before it fails.
    Write {
        /// The index that changed.
        index_name: String,
    },
    /// `index_name` finished spreading its documents from `old_count` partitions across `new_count`.
    PartitionRebalance {
        /// The index that the engine rebalanced.
        index_name: String,
        /// The number of partitions before the rebalance.
        old_count: usize,
        /// The number of partitions after the rebalance.
        new_count: usize,
    },
    /// `index_name` holds `document_count` documents, which passes the `watermark` share of the `capacity` that
    /// its partitions hold. The engine reports each capacity once, until the count drops below the mark again.
    PartitionWatermark {
        /// The index that crossed the mark.
        index_name: String,
        /// The number of documents in the index.
        document_count: u64,
        /// The number of documents that the index's partitions can hold.
        capacity: u64,
        /// The number of partitions in the index.
        partition_count: usize,
    },
    /// A rebuild of the terms of `index_name` reached `status`, after `partitions_rebuilt` of `partition_count`
    /// partitions, with the error that stopped it where it failed.
    AnalysisRebuild {
        /// The index under rebuild.
        index_name: String,
        /// The stage that the rebuild reached.
        status: WorkStatus,
        /// The number of partitions that the rebuild has covered so far.
        partitions_rebuilt: usize,
        /// The number of partitions that the rebuild covers in total.
        partition_count: usize,
        /// The error that stopped the rebuild, which only a failed rebuild carries.
        error: Option<NarsilError>,
    },
    /// The rewrite of `index_name`, which an earlier release saved in `layout`, reached `status` while the engine
    /// recovered the index, with the error that stopped it where it failed.
    LayoutUpgrade {
        /// The index under rewrite.
        index_name: String,
        /// The stage that the rewrite reached.
        status: WorkStatus,
        /// The layout that the earlier release saved.
        layout: EarlierLayout,
        /// The error that stopped the rewrite, which only a failed rewrite carries.
        error: Option<NarsilError>,
    },
    /// A checkpoint that the engine wrote in the background failed, so the writes since the last checkpoint wait in
    /// the write-ahead log, or in memory alone under the snapshot tier.
    DurabilityError {
        /// The index whose checkpoint failed.
        index_name: String,
        /// The error that the checkpoint raised.
        error: NarsilError,
    },
    /// A build of popular query suggestions for `index_name` reached `phase`.
    QuerySuggestionsBuild {
        /// The index whose searches the build reads.
        index_name: String,
        /// The ID of the build.
        build_id: String,
        /// The stage that the build reached.
        phase: QuerySuggestionsBuildPhase,
        /// What started the build.
        trigger: QuerySuggestionsBuildTrigger,
        /// The number of suggestions that the build added or whose count it changed.
        published: u64,
        /// The number of suggestions that the build removed.
        removed: u64,
        /// The number of phrases that the build left out at its limits.
        discarded: u64,
        /// The code of the error that stopped a failed build.
        error_code: Option<String>,
    },
    /// The engine worked around a problem with the popular query suggestions of `index_name`.
    QuerySuggestionsWarning {
        /// The index that the problem concerns.
        index_name: String,
        /// The problem.
        reason: QuerySuggestionsWarningReason,
        /// The key of the file that the problem concerns, where it concerns one.
        file: Option<String>,
        /// The message of the error behind the problem, where an error caused it.
        message: Option<String>,
    },
}

impl NarsilEvent {
    /// Returns the kind of this event.
    pub fn kind(&self) -> NarsilEventKind {
        match self {
            NarsilEvent::Write { .. } => NarsilEventKind::Write,
            NarsilEvent::PartitionRebalance { .. } => NarsilEventKind::PartitionRebalance,
            NarsilEvent::PartitionWatermark { .. } => NarsilEventKind::PartitionWatermark,
            NarsilEvent::AnalysisRebuild { .. } => NarsilEventKind::AnalysisRebuild,
            NarsilEvent::LayoutUpgrade { .. } => NarsilEventKind::LayoutUpgrade,
            NarsilEvent::DurabilityError { .. } => NarsilEventKind::DurabilityError,
            NarsilEvent::QuerySuggestionsBuild { .. } => NarsilEventKind::QuerySuggestionsBuild,
            NarsilEvent::QuerySuggestionsWarning { .. } => NarsilEventKind::QuerySuggestionsWarning,
        }
    }
}

/// The handle of a registered listener, which [`Narsil::off`] takes to remove it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ListenerId(u64);

pub(crate) type Listener = Arc<dyn Fn(&NarsilEvent) + Send + Sync>;

/// The listeners of one engine, with the capacity at which each index last reported its watermark.
#[derive(Default)]
pub(crate) struct EventBus {
    listeners: RwLock<Vec<(ListenerId, NarsilEventKind, Listener)>>,
    next_id: AtomicU64,
    watermarks: Mutex<HashMap<String, u64>>,
}

impl EventBus {
    fn listens(&self, kind: NarsilEventKind) -> bool {
        self.listeners
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .any(|(_, listened, _)| *listened == kind)
    }

    /// Passes `event` to each listener of its kind, holding no lock while a listener works, and drops any panic
    /// that a listener raises, so that a listener can never break the work that raised the event.
    pub(crate) fn emit(&self, event: NarsilEvent) {
        let kind = event.kind();
        let listeners: Vec<Listener> = self
            .listeners
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .filter(|(_, listened, _)| *listened == kind)
            .map(|(_, _, listener)| Arc::clone(listener))
            .collect();
        if listeners.is_empty() {
            return;
        }
        let dispatcher = address_of(self);
        if let Some((listeners, event)) = queue_while_held(dispatcher, listeners, event) {
            deliver(dispatcher, &listeners, &event);
        }
    }

    pub(crate) fn add_listener(&self, kind: NarsilEventKind, listener: Listener) -> ListenerId {
        let id = ListenerId(self.next_id.fetch_add(1, Ordering::Relaxed));
        self.listeners
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((id, kind, listener));
        id
    }

    pub(crate) fn remove_listener(&self, id: ListenerId) -> bool {
        let mut listeners = self
            .listeners
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = listeners.len();
        listeners.retain(|(registered, _, _)| *registered != id);
        listeners.len() != before
    }

    /// Raises a write event for `index_name` where any listener hears one.
    pub(crate) fn wrote(&self, index_name: &str) {
        if self.listens(NarsilEventKind::Write) {
            self.emit(NarsilEvent::Write {
                index_name: index_name.to_string(),
            });
        }
    }

    /// Raises the watermark event of `index` once its document count reaches the share of its capacity that its
    /// `watermark` sets, and forgets the report once the count drops below that share again.
    pub(crate) fn check_watermark(&self, index: &IndexState) {
        let config = index.config();
        let Some((per_partition, watermark)) = config
            .partitions
            .and_then(|limits| Some((limits.max_docs_per_partition?, limits.watermark?)))
        else {
            return;
        };
        let partition_count = index.partitions().len();
        let capacity = per_partition.saturating_mul(partition_count as u64);
        let document_count = index.document_count();
        let reached = document_count as f64 >= watermark * capacity as f64;
        {
            let mut watermarks = self
                .watermarks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !reached {
                watermarks.remove(&index.name);
                return;
            }
            if watermarks.insert(index.name.clone(), capacity) == Some(capacity) {
                return;
            }
        }
        self.emit(NarsilEvent::PartitionWatermark {
            index_name: index.name.clone(),
            document_count,
            capacity,
            partition_count,
        });
    }

    /// Forgets the watermark report of an index that the engine dropped.
    pub(crate) fn forget(&self, index_name: &str) {
        self.watermarks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(index_name);
    }
}

impl Narsil {
    /// Registers `listener` for every event of `kind` from now on and returns the handle that
    /// [`Narsil::off`] takes.
    ///
    /// Most events report work that the engine does away from the call that started it, such as a background
    /// checkpoint that fails. The engine calls each listener on the thread that raised the event and ignores a panic
    /// inside a listener. Where the call that raised the event holds an index, a listener's create, drop, restore,
    /// close, or reopen of that index, or its change to that index's query suggestions, fails at once with
    /// `CONFIG_INVALID`, and a [`Narsil::shutdown`] from a listener returns at once while another shutdown is under
    /// way. A listener that
    /// [`Narsil::open_with`] registers inside its `register` step also hears the events that recovery raises.
    pub fn on(
        &self,
        kind: NarsilEventKind,
        listener: impl Fn(&NarsilEvent) + Send + Sync + 'static,
    ) -> ListenerId {
        self.inner.events.add_listener(kind, Arc::new(listener))
    }

    /// Removes the listener that `id` names, so that it hears no further events, and reports whether it was
    /// registered.
    pub fn off(&self, id: ListenerId) -> bool {
        self.inner.events.remove_listener(id)
    }
}
