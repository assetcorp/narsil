use std::sync::Arc;

use super::Narsil;
use super::index::IndexState;
use crate::config::{
    Bm25FieldParams, Bm25Params, IndexConfig, PartitionConfig, validate_bm25_params,
    validate_partition_config,
};
use crate::error::{ErrorCode, NarsilError, Result};

/// Returns the BM25 setting that an index keeps: the given values, without a field pair that sets nothing, with the
/// last pair of a field that the setting gives twice, and `None` where nothing is set.
fn stored_bm25(params: &Bm25Params) -> Option<Bm25Params> {
    let mut fields: Vec<(String, Bm25FieldParams)> = Vec::new();
    for (name, pair) in params.fields.iter().flatten() {
        let at = fields.iter().position(|(kept, _)| kept == name);
        let sets_value = pair.k1.is_some() || pair.b.is_some();
        match (at, sets_value) {
            (Some(at), true) => fields[at].1 = *pair,
            (Some(at), false) => {
                fields.remove(at);
            }
            (None, true) => fields.push((name.clone(), *pair)),
            (None, false) => {}
        }
    }
    let stored = Bm25Params {
        k1: params.k1,
        b: params.b,
        fields: (!fields.is_empty()).then_some(fields),
    };
    (stored.k1.is_some() || stored.b.is_some() || stored.fields.is_some()).then_some(stored)
}

/// Replaces the settings of `index` with the result of `change`, while the caller holds its write lock. A durable
/// index records the new settings in its metadata file, and goes back to the old settings where that write fails.
pub(crate) fn replace_settings(
    index: &IndexState,
    change: impl FnOnce(&mut IndexConfig),
) -> Result<()> {
    let previous = index.config();
    let mut next = (*previous).clone();
    change(&mut next);
    index.replace_config(Arc::new(next));
    if let Some(log) = index.log()
        && let Err(error) = log.write_metadata(index)
    {
        index.replace_config(previous);
        return Err(error);
    }
    Ok(())
}

fn capacity_exceeded(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::PARTITION_CAPACITY_EXCEEDED, message)
}

fn update_partition_limits(index: &IndexState, change: &PartitionConfig) -> Result<()> {
    if index.changes.is_rebalancing() {
        return Err(NarsilError::new(
            ErrorCode::PARTITION_REBALANCING_BACKPRESSURE,
            format!("Index \"{}\" is currently being rebalanced", index.name),
        ));
    }
    validate_partition_config(change)?;
    let partition_count = index.partitions().len() as u64;
    if let Some(max_partitions) = change.max_partitions
        && max_partitions < partition_count
    {
        return Err(capacity_exceeded(format!(
            "maxPartitions ({max_partitions}) is less than the current partition count ({partition_count})"
        )));
    }
    let current = index.config().partitions.unwrap_or_default();
    let document_count = index.document_count();
    if let Some(per_partition) = change
        .max_docs_per_partition
        .or(current.max_docs_per_partition)
    {
        let capacity = per_partition.saturating_mul(partition_count);
        if capacity < document_count {
            return Err(capacity_exceeded(format!(
                "New capacity ({capacity}) is less than current document count ({document_count})"
            )));
        }
    }
    replace_settings(index, |config| {
        let mut limits = config.partitions.unwrap_or_default();
        if change.max_docs_per_partition.is_some() {
            limits.max_docs_per_partition = change.max_docs_per_partition;
        }
        if change.max_partitions.is_some() {
            limits.max_partitions = change.max_partitions;
        }
        if change.watermark.is_some() {
            limits.watermark = change.watermark;
        }
        config.partitions = Some(limits);
    })
}

impl Narsil {
    /// Replaces the BM25 setting of an index, so that every search that starts after the call returns scores under
    /// the new setting.
    ///
    /// The call replaces the whole setting, so a value that it leaves out returns to its default, and
    /// `Bm25Params::default()` clears the setting. The engine rebuilds nothing, because the setting changes no
    /// stored term, and a durable engine records the setting in the index's metadata so that a restart keeps it.
    /// A cursor from before the change keeps working, and its next pages can repeat or skip documents, because the
    /// scores that order them can change.
    ///
    /// Fails with `CONFIG_INVALID` where `k1` is not a finite number from 0 to 1,000, where `b` is not a finite
    /// number from 0 to 1, or where `fields` gives a name that is no text field of the schema, and with
    /// `PERSISTENCE_SAVE_FAILED` where the metadata write fails. The index keeps its old setting on any failure.
    pub fn update_bm25(&self, index: &str, bm25: &Bm25Params) -> Result<()> {
        self.inner.on_current_index(index, |state| {
            let _writer = state.lock_writes()?;
            validate_bm25_params(bm25, &state.schema, ErrorCode::CONFIG_INVALID, true)?;
            let stored = stored_bm25(bm25);
            replace_settings(state, |config| config.bm25 = stored)
        })
    }

    /// Changes how many documents an index accepts and when it reports that it is filling up, without moving the
    /// documents that it holds. Each field of `change` that is `None` keeps its current value.
    ///
    /// A durable engine records the new limits in the index's metadata so that a restart keeps them. Fails with
    /// `PARTITION_REBALANCING_BACKPRESSURE` while a rebalance of the index runs, with `CONFIG_INVALID` where a
    /// field breaks a limit, and with `PARTITION_CAPACITY_EXCEEDED` where `max_partitions` is below the current
    /// partition count or where the new capacity is below the number of documents that the index holds.
    pub fn update_partition_config(&self, index: &str, change: &PartitionConfig) -> Result<()> {
        let state = self.inner.on_current_index(index, |state| {
            let _writer = state.lock_writes()?;
            update_partition_limits(state, change)?;
            Ok(std::sync::Arc::clone(state))
        })?;
        self.inner.events.check_watermark(&state);
        Ok(())
    }
}
