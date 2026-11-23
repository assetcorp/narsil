use crate::allocator::{Assignment, Table};
use crate::constants::HIDDEN_GENERATION_PREFIX;
use crate::controller::index_metadata;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::ClusterResult;

pub(super) struct ServedIndex {
    pub(super) index_name: String,
    pub(super) serving_name: String,
    pub(super) partition_count: f64,
    pub(super) replication_factor: f64,
    pub(super) table: Option<Table>,
}

async fn serving_table_of(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<(String, Option<Table>)> {
    let named = coordinator.allocation(index_name).await?;
    let Some(generation) = named.as_ref().and_then(|table| table.generation.clone()) else {
        return Ok((
            index_name.to_string(),
            named.map(|table| Table::from_stored(&table)),
        ));
    };
    let served = coordinator.allocation(&generation).await?;
    Ok((generation, served.map(|table| Table::from_stored(&table))))
}

async fn served_index(
    coordinator: &EtcdCoordinator,
    index_name: String,
) -> ClusterResult<Option<ServedIndex>> {
    let (serving_name, table) = serving_table_of(coordinator, &index_name).await?;
    if let Some(table) = table.filter(|table| !table.assignments.is_empty()) {
        return Ok(Some(ServedIndex {
            index_name,
            serving_name,
            partition_count: table.assignments.len() as f64,
            replication_factor: table.replication_factor,
            table: Some(table),
        }));
    }
    let mut metadata = index_metadata(coordinator, &serving_name).await?;
    if metadata.is_none() && serving_name != index_name {
        metadata = index_metadata(coordinator, &index_name).await?;
    }
    Ok(metadata.map(|metadata| ServedIndex {
        index_name,
        serving_name,
        partition_count: metadata.partition_count,
        replication_factor: metadata.replication_factor,
        table: None,
    }))
}

pub(super) async fn served_indexes(
    coordinator: &EtcdCoordinator,
) -> ClusterResult<Vec<ServedIndex>> {
    let mut names: Vec<String> = coordinator
        .list_schemas()
        .await?
        .into_iter()
        .filter(|name| !name.starts_with(HIDDEN_GENERATION_PREFIX))
        .collect();
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let mut served = Vec::with_capacity(names.len());
    for index_name in names {
        if let Some(index) = served_index(coordinator, index_name).await? {
            served.push(index);
        }
    }
    Ok(served)
}

pub(super) fn in_sync_replicas_of(assignment: &Assignment) -> impl Iterator<Item = &String> {
    assignment.replicas.iter().filter(|replica| {
        assignment.primary.as_ref() != Some(*replica) && assignment.in_sync_set.contains(replica)
    })
}
