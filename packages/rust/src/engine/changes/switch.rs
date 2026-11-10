use std::sync::Arc;

use crate::config::IndexConfig;
use crate::engine::durable::switch::{SwitchFailure, checkpoint_switch};
use crate::engine::index::IndexState;
use crate::engine::layout::TextLayout;
use crate::engine::sync::{release_sync, renew_sync_epoch};
use crate::format::metadata::IndexMetadata;

/// The partitions and settings that replace an index's own once a change has built them, with the change that
/// the index's metadata records for them.
pub(crate) struct LayoutSwitch<'a> {
    pub(crate) layout: TextLayout,
    pub(crate) config: Arc<IndexConfig>,
    pub(crate) record: &'a dyn Fn(&mut IndexMetadata),
}

/// Replaces the partitions and settings of `index` while the caller holds its write lock. A durable index then
/// commits a checkpoint of the new partitions with the new metadata, and goes back to its old partitions and
/// settings where that checkpoint fails, so that a restart finds the old or the new state whole.
pub(crate) fn switch_layout(
    index: &IndexState,
    switch: LayoutSwitch<'_>,
) -> Result<(), SwitchFailure> {
    let previous_layout = index.partitions();
    let previous_config = index.config();
    let before = index.log().map(|log| log.metadata(index));
    index.replace_layout(switch.layout);
    index.replace_config(switch.config);
    let (Some(log), Some(before)) = (index.log(), before) else {
        return Ok(());
    };
    let mut metadata = log.metadata(index);
    (switch.record)(&mut metadata);
    let renewed = match renew_sync_epoch(&mut metadata) {
        Ok(renewed) => renewed,
        Err(error) => {
            index.restore_layout(previous_layout);
            index.replace_config(previous_config);
            return Err(SwitchFailure::BeforeCommit(error));
        }
    };
    if let Err(failure) = checkpoint_switch(index, log, metadata) {
        index.restore_layout(previous_layout);
        index.replace_config(previous_config);
        log.remember(before);
        return Err(failure);
    }
    if renewed {
        let _ = release_sync(index);
    }
    Ok(())
}
