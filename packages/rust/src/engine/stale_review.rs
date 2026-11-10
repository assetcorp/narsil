use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, Weak};

use super::EngineInner;
use super::analysis_change::{has_pending_change, rebuild_named};
use super::engine_config::{AnalysisRebuildMode, StaleAnalysis};
use super::events::{NarsilEvent, WorkStatus};
use super::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};

/// Rebuilds the stale terms of one index when the program runs it, from any thread and at any later time.
#[derive(Clone)]
pub struct StaleRebuild {
    engine: Weak<EngineInner>,
    index_name: String,
}

impl std::fmt::Debug for StaleRebuild {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StaleRebuild")
            .field("index_name", &self.index_name)
            .finish()
    }
}

impl StaleRebuild {
    /// Returns the index that this rebuild covers.
    pub fn index_name(&self) -> &str {
        &self.index_name
    }

    /// Rebuilds the index's terms under the analysis that its settings give now, and returns once every partition
    /// holds current terms, as [`crate::Narsil::rebuild_analysis`] does.
    ///
    /// Fails with `INSTANCE_SHUT_DOWN` once the engine has shut down or dropped, and otherwise as
    /// [`crate::Narsil::rebuild_analysis`] does.
    pub fn run(&self) -> Result<()> {
        let Some(engine) = self.engine.upgrade() else {
            return Err(NarsilError::new(
                ErrorCode::INSTANCE_SHUT_DOWN,
                "This Narsil instance has been shut down",
            ));
        };
        rebuild_named(&engine, &self.index_name)
    }
}

/// The lock that each automatic rebuild holds, so that the engine rebuilds one stale index at a time and never
/// holds two extra copies of terms at once.
#[derive(Default)]
pub(crate) struct RebuildQueue {
    turn: Mutex<()>,
}

fn stale_facts(index: &IndexState) -> StaleAnalysis {
    let language = index.analyser().language().clone();
    let stored_revision = index
        .log()
        .and_then(|log| log.metadata(index).analysis_revision);
    StaleAnalysis {
        index_name: index.name.clone(),
        language: language.name().to_string(),
        stored_revision,
        current_revision: language.revision().to_string(),
        document_count: index.document_count(),
    }
}

fn listener_failed(engine: &EngineInner, index: &IndexState) {
    engine.events.emit(NarsilEvent::AnalysisRebuild {
        index_name: index.name.clone(),
        status: WorkStatus::Failed,
        partitions_rebuilt: 0,
        partition_count: index.partitions().len(),
        error: Some(NarsilError::new(
            ErrorCode::INTERNAL_ERROR,
            format!(
                "The onStaleAnalysis listener panicked while the engine reported index \"{}\"",
                index.name
            ),
        )),
    });
}

fn rebuild_in_background(engine: &Arc<EngineInner>, names: Vec<String>) {
    let weak = Arc::downgrade(engine);
    let _ = std::thread::Builder::new()
        .name("narsil-stale-rebuild".to_string())
        .spawn(move || {
            for name in names {
                let Some(engine) = weak.upgrade() else {
                    return;
                };
                let _turn = engine
                    .rebuild_queue
                    .turn
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let Some(index) = engine.open_index_named(&name) else {
                    continue;
                };
                if index.analysis_stale() && engine.guard_shutdown().is_ok() {
                    let _ = rebuild_named(&engine, &name);
                }
            }
        });
}

/// Reports each stale index of `indexes` to the stale analysis listener, in order, and then rebuilds them on a
/// background thread where the engine rebuilds automatically. An index with a recorded analysis change is left
/// to that change, which rebuilds its terms as it finishes.
pub(crate) fn review_stale(engine: &Arc<EngineInner>, indexes: Vec<Arc<IndexState>>) {
    let stale: Vec<Arc<IndexState>> = indexes
        .into_iter()
        .filter(|index| index.analysis_stale() && !has_pending_change(index))
        .collect();
    if stale.is_empty() {
        return;
    }
    if let Some(listener) = &engine.settings.on_stale_analysis {
        for index in &stale {
            let handle = StaleRebuild {
                engine: Arc::downgrade(engine),
                index_name: index.name.clone(),
            };
            let facts = stale_facts(index);
            if catch_unwind(AssertUnwindSafe(|| listener(&facts, handle))).is_err() {
                listener_failed(engine, index);
            }
        }
    }
    if engine.settings.rebuild_mode == AnalysisRebuildMode::Auto {
        let names = stale.iter().map(|index| index.name.clone()).collect();
        rebuild_in_background(engine, names);
    }
}
