use std::collections::HashSet;
use std::sync::Arc;

use crate::durability::store::DurabilityStore;
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::metadata_parts::is_sync_epoch;

use super::filter::ChangeFilter;
use super::step::Following;
use super::types::{ChangePosition, ChangesRequest, ChangesSubscribed, ResyncReason};

pub(super) enum Opened {
    Following(Box<Following>, ChangesSubscribed),
    Resync(ResyncReason),
}

pub(super) fn not_enabled(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::CHANGES_NOT_ENABLED,
        format!("Index \"{index_name}\" has change capture off"),
    )
}

pub(super) fn previous_document_required(index_name: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::CHANGES_PREVIOUS_DOCUMENT_REQUIRED,
        format!(
            "Index \"{index_name}\" records no previous document, so a request for its changes cannot hold a filter"
        ),
    )
}

fn invalid_positions(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::CHANGES_INVALID_POSITIONS, message)
}

fn require_request_shape(request: &ChangesRequest) -> Result<()> {
    match (&request.epoch, &request.positions) {
        (Some(epoch), Some(_)) if !is_sync_epoch(epoch) => Err(invalid_positions(
            "The epoch of a request for changes must be 32 lowercase hexadecimal digits"
                .to_string(),
        )),
        (Some(_), None) | (None, Some(_)) => Err(invalid_positions(
            "A request for changes gives both an epoch and positions, or neither".to_string(),
        )),
        _ => Ok(()),
    }
}

fn require_positions(
    index_name: &str,
    positions: &[ChangePosition],
    partition_count: usize,
) -> Result<Vec<u64>> {
    let mut seen = HashSet::new();
    let mut ordered = vec![0u64; partition_count];
    for position in positions {
        let at = position.partition_id as usize;
        if at >= partition_count {
            return Err(invalid_positions(format!(
                "Index \"{index_name}\" has {partition_count} partitions, so it holds no partition {}",
                position.partition_id
            )));
        }
        if !seen.insert(at) {
            return Err(invalid_positions(format!(
                "The positions repeat partition {}",
                position.partition_id
            )));
        }
        ordered[at] = position.seq_no;
    }
    if seen.len() != partition_count {
        return Err(invalid_positions(format!(
            "The positions leave out a partition of index \"{index_name}\", which has {partition_count}"
        )));
    }
    Ok(ordered)
}

fn positions_of(seq_nos: &[u64]) -> Vec<ChangePosition> {
    seq_nos
        .iter()
        .enumerate()
        .map(|(partition_id, seq_no)| ChangePosition {
            partition_id: partition_id as u32,
            seq_no: *seq_no,
        })
        .collect()
}

pub(super) fn open_locked(
    index: &IndexState,
    store: &Arc<DurabilityStore>,
    request: &ChangesRequest,
) -> Result<Opened> {
    require_request_shape(request)?;
    let Some(log) = index.log() else {
        return Err(not_enabled(&index.name));
    };
    let (Some(epoch), records_previous) = log.recorded_capture() else {
        return Err(not_enabled(&index.name));
    };
    let filter = match &request.filter {
        Some(_) if !records_previous => return Err(previous_document_required(&index.name)),
        Some(filter) => Some(ChangeFilter::new(filter, index)?),
        None => None,
    };
    if let Some(requested) = &request.epoch
        && *requested != epoch
    {
        return Ok(Opened::Resync(ResyncReason::Epoch));
    }
    let partition_count = index.partitions().len();
    let given = request
        .positions
        .as_deref()
        .map(|positions| require_positions(&index.name, positions, partition_count))
        .transpose()?;
    let mut heads = Vec::with_capacity(partition_count);
    for partition_id in 0..partition_count as u32 {
        heads.push(store.log_positions(&index.name, partition_id)?);
    }
    if let Some(given) = &given {
        for (position, bounds) in given.iter().zip(&heads) {
            if *position < bounds.oldest.saturating_sub(1) {
                return Ok(Opened::Resync(ResyncReason::History));
            }
            if *position > bounds.highest {
                return Ok(Opened::Resync(ResyncReason::Ahead));
            }
        }
    }
    let heads: Vec<u64> = heads.iter().map(|bounds| bounds.head).collect();
    let starts = given.unwrap_or_else(|| heads.clone());
    let subscribed = ChangesSubscribed {
        epoch: epoch.clone(),
        partition_count: partition_count as u32,
        positions: positions_of(&starts),
        heads: positions_of(&heads),
        bytes_behind: 0,
        previous_document: records_previous,
    };
    let following = Following::new(epoch, filter, &starts, heads);
    Ok(Opened::Following(Box::new(following), subscribed))
}

pub(super) fn bytes_behind(
    store: &DurabilityStore,
    index_name: &str,
    positions: &[ChangePosition],
) -> Result<u64> {
    let mut bytes = 0u64;
    for position in positions {
        bytes = bytes.saturating_add(store.log_bytes_after(
            index_name,
            position.partition_id,
            position.seq_no,
        )?);
    }
    Ok(bytes)
}

pub(super) fn log_store_for_changes(index: &IndexState) -> Result<Arc<DurabilityStore>> {
    index
        .log()
        .and_then(|log| log.log_store())
        .cloned()
        .ok_or_else(|| not_enabled(&index.name))
}
