use narsil::Value;
use narsil::suggestions_host::BuildRecord;

use crate::constants::{
    MAX_BUILD_RECORD_WRITE_ATTEMPTS, QUERY_SUGGESTIONS_BUILD_RECORD_KEY_PREFIX,
    QUERY_SUGGESTIONS_BUILD_RECORD_KEY_SUFFIX,
};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};

pub(crate) fn build_record_coordinator_key(index_name: &str) -> String {
    format!(
        "{QUERY_SUGGESTIONS_BUILD_RECORD_KEY_PREFIX}{index_name}{QUERY_SUGGESTIONS_BUILD_RECORD_KEY_SUFFIX}"
    )
}

pub(crate) async fn read_cluster_build_record(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<Option<BuildRecord>> {
    match coordinator
        .get(&build_record_coordinator_key(index_name))
        .await?
    {
        Some(bytes) if !bytes.is_empty() => Ok(BuildRecord::from_wire(&bytes)),
        _ => Ok(None),
    }
}

pub(crate) async fn write_cluster_build_record(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    record: &BuildRecord,
) -> ClusterResult<()> {
    let key = build_record_coordinator_key(index_name);
    let next = record.to_wire();
    for _ in 0..MAX_BUILD_RECORD_WRITE_ATTEMPTS {
        let current = coordinator.get(&key).await?;
        if coordinator
            .compare_and_set(&key, current.as_deref(), &next)
            .await?
        {
            return Ok(());
        }
    }
    let build_id = record.build().build_id.as_str();
    Err(ClusterError::new(
        codes::CLUSTER_WRITE_BLOCKED,
        format!(
            "The build record of index '{index_name}' kept changing, so the controller stored no outcome for build '{build_id}'"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail("buildId", Value::from(build_id))
    .with_detail("attempts", Value::from(MAX_BUILD_RECORD_WRITE_ATTEMPTS)))
}

pub(crate) async fn delete_cluster_build_record(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<()> {
    coordinator
        .delete(&build_record_coordinator_key(index_name))
        .await
}
