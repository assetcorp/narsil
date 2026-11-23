use narsil::Value;

use super::ReadDeps;
use crate::allocator::Table;
use crate::controller::stored_index_metadata;
use crate::error::{ClusterError, ClusterResult, codes};

pub(crate) async fn routable_allocation(deps: &ReadDeps, index_name: &str) -> ClusterResult<Table> {
    if let Some(local) = &deps.local {
        local.refuse_orphaned(index_name)?;
    }
    if let Some(table) = deps.view.read(index_name).await?
        && !table.assignments.is_empty()
    {
        return Ok(table);
    }
    if stored_index_metadata(&deps.coordinator, index_name)
        .await?
        .is_none()
    {
        return Err(ClusterError::new(
            codes::INDEX_NOT_FOUND,
            format!("Index \"{index_name}\" does not exist"),
        )
        .with_detail("indexName", Value::from(index_name)));
    }
    Err(ClusterError::new(
        codes::QUERY_ROUTING_FAILED,
        format!(
            "The cluster owns index '{index_name}' and holds no allocation table for it yet, so this node cannot place a read or a write"
        ),
    )
    .with_detail("indexName", Value::from(index_name)))
}

pub(crate) async fn live_allocation_once(deps: &ReadDeps, index_name: &str) -> Option<Table> {
    match deps.view.read_live(index_name).await {
        Ok(Some(live)) if !live.assignments.is_empty() => Some(live),
        _ => None,
    }
}
