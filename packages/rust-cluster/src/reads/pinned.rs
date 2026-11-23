use std::collections::HashSet;
use std::sync::Arc;

use narsil::QueryParams;

use super::ReadDeps;
use super::node_messaging::{CopyRead, read_documents_from_copies};
use crate::allocator::Table;
use crate::data::routed_partition;
use crate::error::ClusterResult;
use crate::query::routing::DistributedResult;
use crate::query::search_answer::ScoredEntry;
use crate::query::selection::collect_active_candidates;

struct PinReachability {
    verifiable: Vec<String>,
    unverifiable: HashSet<String>,
}

fn split_pinned_by_reachability(pinned_ids: &[String], table: &Table) -> PinReachability {
    let partition_count = table.assignments.len();
    let mut split = PinReachability {
        verifiable: Vec::new(),
        unverifiable: HashSet::new(),
    };
    for document_id in pinned_ids {
        let partition_id = routed_partition(document_id, partition_count.max(1));
        let served = table
            .assignments
            .get(f64::from(partition_id))
            .is_some_and(|assignment| !collect_active_candidates(assignment).is_empty());
        match served {
            true => split.verifiable.push(document_id.clone()),
            false => {
                split.unverifiable.insert(document_id.clone());
            }
        }
    }
    split
}

pub(crate) struct PinPresence {
    pub(crate) pinned_ids: HashSet<String>,
    pub(crate) stored: HashSet<String>,
    pub(crate) unverifiable: HashSet<String>,
}

impl PinPresence {
    pub(crate) fn placeable(&self) -> HashSet<String> {
        self.stored.union(&self.unverifiable).cloned().collect()
    }
}

pub(crate) async fn read_pin_presence(
    deps: &Arc<ReadDeps>,
    index_name: &str,
    params: &QueryParams,
    table: &Table,
) -> ClusterResult<Option<PinPresence>> {
    let Some(pinned) = &params.pinned else {
        return Ok(None);
    };
    if params.search_after.is_some() {
        return Ok(None);
    }
    let mut pinned_ids: Vec<String> = Vec::with_capacity(pinned.len());
    for pin in pinned {
        if !pinned_ids.contains(&pin.doc_id) {
            pinned_ids.push(pin.doc_id.clone());
        }
    }
    let split = split_pinned_by_reachability(&pinned_ids, table);
    let stored = match split.verifiable.is_empty() {
        true => HashSet::new(),
        false => read_documents_from_copies(
            deps,
            index_name,
            &split.verifiable,
            table,
            CopyRead {
                fields: None,
                vectors: false,
            },
            true,
            false,
        )
        .await
        .map_err(|failure| failure.error)?
        .into_keys()
        .collect(),
    };
    Ok(Some(PinPresence {
        pinned_ids: pinned_ids.into_iter().collect(),
        stored,
        unverifiable: split.unverifiable,
    }))
}

pub(crate) fn drop_unstored_pinned_entries(
    scored: Vec<ScoredEntry>,
    presence: Option<&PinPresence>,
) -> Vec<ScoredEntry> {
    let Some(presence) = presence else {
        return scored;
    };
    scored
        .into_iter()
        .filter(|entry| {
            !presence.pinned_ids.contains(&entry.doc_id)
                || presence.unverifiable.contains(&entry.doc_id)
                || presence.stored.contains(&entry.doc_id)
        })
        .collect()
}

pub(crate) struct OutsidePins {
    pub(crate) stored: u64,
    pub(crate) every_pin_verified: bool,
}

pub(crate) fn count_stored_pins_from_outside(
    distributed: &DistributedResult,
    presence: Option<&PinPresence>,
) -> OutsidePins {
    let outside = &distributed.pinned_from_outside;
    if outside.is_empty() {
        return OutsidePins {
            stored: 0,
            every_pin_verified: true,
        };
    }
    let Some(presence) = presence else {
        return OutsidePins {
            stored: 0,
            every_pin_verified: false,
        };
    };
    let mut counted = OutsidePins {
        stored: 0,
        every_pin_verified: true,
    };
    for document_id in outside {
        if presence.unverifiable.contains(document_id) {
            counted.every_pin_verified = false;
        } else if presence.stored.contains(document_id) {
            counted.stored += 1;
        }
    }
    counted
}
