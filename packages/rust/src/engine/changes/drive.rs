use std::sync::Arc;

use super::rebuild::{Rebuild, document_total};
use crate::engine::constants::REBUILD_SWITCH_BACKLOG_DOCUMENTS;
use crate::engine::durable::switch::SwitchFailure;
use crate::engine::layout::TextLayout;
use crate::error::NarsilError;
use crate::index::partition::Partition;

fn same_partitions(left: &TextLayout, right: &TextLayout) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right.iter())
            .all(|(left, right)| Arc::ptr_eq(left, right))
}

/// The hooks of one rebuild: the progress of its bulk build, the error that ends it where the index's partitions
/// changed under it, and the switch that its new partitions go through while the write lock is held.
pub(crate) struct DriveHooks<'a> {
    pub(crate) progress: &'a mut dyn FnMut(usize),
    pub(crate) interrupted: &'a dyn Fn() -> NarsilError,
    pub(crate) switch: &'a mut dyn FnMut(Vec<Arc<Partition>>) -> Result<(), SwitchFailure>,
}

/// Builds new partitions from the index's documents while searches keep reading the old ones and writes keep
/// reaching them, applies every document that a write touched meanwhile, and switches to the new partitions once
/// the writes left to apply are few enough to apply under the write lock.
pub(crate) fn rebuild_and_switch(
    rebuild: &Rebuild<'_>,
    hooks: DriveHooks<'_>,
) -> Result<(), SwitchFailure> {
    let index = rebuild.index;
    let (source, snapshots) = {
        let _writer = index.write_lock();
        rebuild
            .require_current()
            .map_err(SwitchFailure::BeforeCommit)?;
        rebuild.ticket.start_tracking();
        let source = index.partitions();
        let snapshots: Vec<_> = source
            .iter()
            .map(|partition| partition.snapshot())
            .collect();
        (source, snapshots)
    };
    let built = rebuild
        .build(&snapshots, hooks.progress)
        .map_err(SwitchFailure::BeforeCommit)?;
    drop(snapshots);
    loop {
        let writer = index.write_lock();
        rebuild
            .require_current()
            .map_err(SwitchFailure::BeforeCommit)?;
        let current = index.partitions();
        if !same_partitions(&source, &current) {
            return Err(SwitchFailure::BeforeCommit((hooks.interrupted)()));
        }
        let written = rebuild.ticket.drain();
        if written.len() <= REBUILD_SWITCH_BACKLOG_DOCUMENTS {
            rebuild
                .apply_written(&built, &current, &written)
                .map_err(SwitchFailure::BeforeCommit)?;
            if document_total(&built) != document_total(&current) {
                return Err(SwitchFailure::BeforeCommit((hooks.interrupted)()));
            }
            let switched = (hooks.switch)(built);
            drop(writer);
            return switched;
        }
        drop(writer);
        rebuild
            .apply_written(&built, &current, &written)
            .map_err(SwitchFailure::BeforeCommit)?;
    }
}
