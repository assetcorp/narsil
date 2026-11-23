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

/// Applies the writes that arrived since its last call to the new partitions, and fails where the rebuild can no
/// longer switch.
pub(crate) type KeepCurrent<'a> = dyn FnMut() -> Result<(), SwitchFailure> + 'a;

/// Waits before the switch for as long as the caller holds the new partitions aside, calling the function that it
/// receives to keep them current, and fails where the held change ends without a switch.
pub(crate) type HoldBeforeSwitch<'a> =
    dyn Fn(&mut KeepCurrent<'_>) -> Result<(), SwitchFailure> + 'a;

/// The hooks of one rebuild: the progress of its bulk build, the error that ends it where the index's partitions
/// changed under it, the wait that holds its new partitions aside before the switch, and the switch that its new
/// partitions go through while the write lock is held.
pub(crate) struct DriveHooks<'a> {
    pub(crate) progress: &'a mut dyn FnMut(usize),
    pub(crate) interrupted: &'a dyn Fn() -> NarsilError,
    pub(crate) hold_before_switch: Option<&'a HoldBeforeSwitch<'a>>,
    pub(crate) switch: &'a mut dyn FnMut(Vec<Arc<Partition>>) -> Result<(), SwitchFailure>,
}

fn apply_since_last<'a>(
    rebuild: &'a Rebuild<'a>,
    source: &'a TextLayout,
    built: &'a [Arc<Partition>],
    interrupted: &'a dyn Fn() -> NarsilError,
) -> impl FnMut() -> Result<(), SwitchFailure> + 'a {
    move || {
        let index = rebuild.index;
        let writer = index.write_lock();
        rebuild
            .require_current()
            .map_err(SwitchFailure::BeforeCommit)?;
        let current = index.partitions();
        if !same_partitions(source, &current) {
            return Err(SwitchFailure::BeforeCommit(interrupted()));
        }
        let written = rebuild.ticket.drain();
        drop(writer);
        rebuild
            .apply_written(built, &current, &written)
            .map_err(SwitchFailure::BeforeCommit)
    }
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
    if let Some(hold_before_switch) = hooks.hold_before_switch {
        let mut keep_current = apply_since_last(rebuild, &source, &built, hooks.interrupted);
        hold_before_switch(&mut keep_current)?;
    }
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
