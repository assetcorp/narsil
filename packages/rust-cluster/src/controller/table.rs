use std::collections::HashSet;

use super::metadata::index_metadata;
use crate::allocator::{Assignment, Table};
use crate::coordinator::ExpectedReplicaRegistration;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::ClusterResult;

fn hold_same_members(left: &[String], right: &[String]) -> bool {
    let left: HashSet<&String> = left.iter().collect();
    let right: HashSet<&String> = right.iter().collect();
    left == right
}

fn drops_a_replica(previous: &Assignment, next: &Assignment) -> bool {
    previous
        .replicas
        .iter()
        .any(|node_id| !next.holds_replica(node_id))
}

fn stamped_in_sync_version(previous: Option<&Assignment>, next: &Assignment) -> f64 {
    let Some(previous) = previous else {
        return next.in_sync_version_of();
    };
    let stored = previous.in_sync_version_of();
    let unchanged = hold_same_members(&previous.in_sync_set, &next.in_sync_set)
        && !drops_a_replica(previous, next);
    let raised = if unchanged { stored } else { stored + 1.0 };
    raised.max(next.in_sync_version_of())
}

pub(crate) fn with_in_sync_versions(previous: Option<&Table>, mut next: Table) -> Table {
    for partition_id in next.assignments.ids() {
        let earlier = previous.and_then(|table| table.assignments.get(partition_id));
        let Some(assignment) = next.assignments.get_mut(partition_id) else {
            continue;
        };
        let version = stamped_in_sync_version(earlier, assignment);
        if version != assignment.in_sync_version_of() {
            assignment.in_sync_version = Some(version);
        }
    }
    next
}

pub(crate) struct TableWrite<'a> {
    pub(crate) index_name: &'a str,
    pub(crate) previous: Option<&'a Table>,
    pub(crate) writer_node_id: &'a str,
    pub(crate) replica: Option<&'a ExpectedReplicaRegistration>,
}

pub(crate) async fn put_allocation_over(
    coordinator: &EtcdCoordinator,
    write: TableWrite<'_>,
    next: Table,
) -> ClusterResult<bool> {
    let TableWrite {
        index_name,
        previous,
        writer_node_id,
        replica,
    } = write;
    let stamped = with_in_sync_versions(previous, next);
    coordinator
        .put_allocation_guarded(
            index_name,
            &stamped.to_stored(),
            previous.map(|table| table.version),
            writer_node_id,
            replica,
        )
        .await
}

pub(crate) fn belongs_to_another_index(table: &Table, index_uuid: Option<&str>) -> bool {
    match (&table.index_uuid, index_uuid) {
        (Some(stored), Some(current)) => stored != current,
        _ => false,
    }
}

pub(crate) fn stamped_with(mut table: Table, index_uuid: Option<&str>) -> Table {
    if let Some(index_uuid) = index_uuid {
        table.index_uuid = Some(index_uuid.to_string());
    }
    table
}

pub(crate) async fn rewrite_for_current_index(
    coordinator: &EtcdCoordinator,
    table: Table,
) -> ClusterResult<Option<Table>> {
    let metadata = index_metadata(coordinator, &table.index_name).await?;
    let index_uuid = metadata
        .as_ref()
        .map(|metadata| metadata.index_uuid.as_str());
    if belongs_to_another_index(&table, index_uuid) {
        return Ok(None);
    }
    Ok(Some(stamped_with(table, index_uuid)))
}

pub(crate) async fn stored_table(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<Option<Table>> {
    Ok(coordinator
        .allocation(index_name)
        .await?
        .map(|table| Table::from_stored(&table)))
}
