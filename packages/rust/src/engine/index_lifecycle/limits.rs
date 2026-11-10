use std::sync::Arc;

use super::close_index;
use crate::engine::EngineInner;
use crate::engine::engine_config::LifecycleLimits;
use crate::engine::index::IndexState;
use crate::engine::stats::index_bytes;

fn exceeds(limits: &LifecycleLimits, open: &[Arc<IndexState>]) -> bool {
    let count = u64::try_from(open.len()).unwrap_or(u64::MAX);
    if limits
        .max_open_indexes
        .is_some_and(|maximum| count > maximum)
    {
        return true;
    }
    let Some(maximum) = limits.max_open_bytes else {
        return false;
    };
    let bytes = open.iter().fold(0u64, |total, index| {
        total.saturating_add(index_bytes(index))
    });
    bytes > maximum
}

/// Closes the least recently used open indexes, other than `protected`, until the open count and the estimated
/// open bytes fall within the lifecycle limits, or until every remaining index is busy.
pub(crate) fn enforce_limits(engine: &EngineInner, protected: Option<&str>) {
    let Some(limits) = engine.lifecycle.limits else {
        return;
    };
    if limits.max_open_indexes.is_none() && limits.max_open_bytes.is_none() {
        return;
    }
    if engine.durable.is_none() {
        return;
    }
    loop {
        let open = engine.index_list();
        if !exceeds(&limits, &open) {
            return;
        }
        let mut candidates: Vec<Arc<IndexState>> = open
            .into_iter()
            .filter(|index| Some(index.name.as_str()) != protected)
            .filter(|index| index.residency.active_writes() == 0)
            .collect();
        candidates.sort_by_key(|index| index.residency.last_access_ms());
        let closed_one = candidates
            .iter()
            .any(|index| matches!(close_index(engine, &index.name, true), Ok(true)));
        if !closed_one {
            return;
        }
    }
}
