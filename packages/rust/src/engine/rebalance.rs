use std::sync::Arc;

use super::changes::ChangeKind;
use super::changes::drive::{DriveHooks, rebuild_and_switch};
use super::changes::rebuild::Rebuild;
use super::changes::switch::{LayoutSwitch, switch_layout};
use super::events::NarsilEvent;
use super::index::IndexState;
use super::{EngineInner, Narsil};
use crate::config::MAX_PARTITIONS;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::partition::Partition;

fn capacity_exceeded(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::PARTITION_CAPACITY_EXCEEDED, message)
}

fn require_target(index: &IndexState, target: usize) -> Result<()> {
    if target == 0 {
        return Err(capacity_exceeded(format!(
            "Target partition count must be a positive integer, got {target}"
        )));
    }
    let ceiling = index
        .config()
        .partitions
        .and_then(|limits| limits.max_partitions)
        .unwrap_or(MAX_PARTITIONS)
        .min(MAX_PARTITIONS);
    if target as u64 > ceiling {
        return Err(capacity_exceeded(format!(
            "Target partition count ({target}) is above the maximum of {ceiling} partitions"
        )));
    }
    Ok(())
}

fn require_no_pending_analysis(index: &IndexState) -> Result<()> {
    let pending = index
        .log()
        .is_some_and(|log| log.metadata(index).pending_analysis.is_some());
    if !pending {
        return Ok(());
    }
    Err(NarsilError::new(
        ErrorCode::PARTITION_REBALANCING_BACKPRESSURE,
        format!(
            "Index \"{}\" is changing its analysis settings, so try the rebalance again once the change ends",
            index.name
        ),
    ))
}

fn changed_under_rebalance(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PARTITION_REBALANCING_BACKPRESSURE,
        format!(
            "The partitions of index \"{index_name}\" changed while the rebalance ran, so try the rebalance again"
        ),
    )
}

/// Spreads the documents of `index` over `target` partitions and returns the partition count that it had, or
/// `None` where the index already holds that many.
fn rebalance_index(
    engine: &EngineInner,
    index: &IndexState,
    target: usize,
) -> Result<Option<usize>> {
    require_target(index, target)?;
    let ticket = index
        .changes
        .claim(ChangeKind::Rebalance, &index.name, false)?;
    require_no_pending_analysis(index)?;
    let layout = index.partitions();
    let old_count = layout.len();
    if target == old_count {
        return Ok(None);
    }
    ticket.set_rebalance_target(target);
    let rebuild = Rebuild {
        engine,
        index,
        ticket: &ticket,
        analyser: &layout.analyser,
        partition_count: target,
    };
    let interrupted = || changed_under_rebalance(&index.name);
    let mut switch = |built: Vec<Arc<Partition>>| {
        let current = index.partitions();
        let record = |_: &mut crate::format::metadata::IndexMetadata| {};
        switch_layout(
            index,
            LayoutSwitch {
                layout: current.with_partitions(built),
                config: index.config(),
                record: &record,
            },
        )
    };
    let hooks = DriveHooks {
        progress: &mut |_| {},
        interrupted: &interrupted,
        switch: &mut switch,
    };
    rebuild_and_switch(&rebuild, hooks).map_err(|failure| failure.into_error())?;
    Ok(Some(old_count))
}

impl Narsil {
    /// Spreads the documents of an index across `target_partition_count` partitions, and returns once the new
    /// partitions answer every search.
    ///
    /// The index keeps answering searches from its old partitions and keeps taking writes while the engine builds
    /// the new ones, and the engine then applies every write that arrived meanwhile, in order, before it switches.
    /// A durable engine writes a checkpoint of the new partitions before it switches, so that a restart finds the
    /// old or the new partitions whole, and keeps the old partitions where that checkpoint fails.
    ///
    /// Fails with `PARTITION_CAPACITY_EXCEEDED` where the count is 0 or above `partitions.max_partitions`, with
    /// `PARTITION_REBALANCING_BACKPRESSURE` while another rebalance or an analysis change of the index runs, and a
    /// write fails with that code while a rebalance holds 10,000 writes that it has yet to apply.
    pub fn rebalance(&self, index: &str, target_partition_count: usize) -> Result<()> {
        let mut reached = None;
        let outcome = self.inner.on_current_index(index, |state| {
            reached = Some(std::sync::Arc::clone(state));
            rebalance_index(&self.inner, state, target_partition_count)
        });
        let Some(state) = reached else {
            return outcome.map(|_| ());
        };
        if let Ok(Some(old_count)) = outcome {
            self.inner.events.emit(NarsilEvent::PartitionRebalance {
                index_name: state.name.clone(),
                old_count,
                new_count: target_partition_count,
            });
            self.inner
                .plugins
                .partition_split(&state.name, old_count, target_partition_count);
            self.inner.events.check_watermark(&state);
        }
        self.inner.events.wrote(&state.name);
        outcome.map(|_| ())
    }
}
