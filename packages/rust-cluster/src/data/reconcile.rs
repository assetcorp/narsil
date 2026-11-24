use std::sync::Arc;

use narsil::Value;

use super::blocking::off_executor;
use super::copies::LocalCopies;
use super::stored_index::stored_index;
use crate::controller::index_metadata;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::node::{NodeErrorHandler, report_failure};

enum Settled {
    Claimed,
    Orphaned(String),
    Unreadable(String),
}

async fn settle(
    coordinator: &EtcdCoordinator,
    copies: &Arc<LocalCopies>,
    index_name: &str,
) -> ClusterResult<Settled> {
    let (held, name) = (Arc::clone(copies), index_name.to_string());
    let local_uuid = match off_executor(move || held.index_uuid(&name)).await? {
        Ok(local_uuid) => local_uuid,
        Err(error) => {
            return Ok(Settled::Orphaned(format!(
                "its stored identity could not be read: {error}"
            )));
        }
    };
    let cluster_uuid = match index_metadata(coordinator, index_name).await {
        Ok(Some(metadata)) => metadata.index_uuid,
        Ok(None) => {
            return Ok(Settled::Orphaned(
                "the coordinator holds no metadata for that name".to_string(),
            ));
        }
        Err(error) => {
            return Ok(Settled::Unreadable(format!(
                "its metadata could not be read: {error}"
            )));
        }
    };
    match local_uuid {
        Some(local_uuid) if local_uuid == cluster_uuid => {}
        Some(_) => {
            let (held, name) = (Arc::clone(copies), index_name.to_string());
            off_executor(move || held.drop_superseded(&name)).await??;
            return Ok(Settled::Claimed);
        }
        None => {
            let (held, name, uuid) = (
                Arc::clone(copies),
                index_name.to_string(),
                cluster_uuid.clone(),
            );
            off_executor(move || held.adopt(&name, &uuid)).await??;
        }
    }
    match apply_stored_settings(coordinator, copies, index_name, &cluster_uuid).await {
        Ok(_) => Ok(Settled::Claimed),
        Err(error) => Ok(Settled::Unreadable(format!(
            "its synonym set and BM25 setting could not be read or applied: {error}"
        ))),
    }
}

pub(super) async fn apply_stored_settings(
    coordinator: &EtcdCoordinator,
    copies: &Arc<LocalCopies>,
    index_name: &str,
    cluster_uuid: &str,
) -> ClusterResult<bool> {
    let Some(schema) = coordinator.schema(index_name).await? else {
        return Ok(false);
    };
    let Some(stored) = stored_index(coordinator, index_name, &schema).await? else {
        return Ok(false);
    };
    if stored.index_uuid != cluster_uuid {
        return Ok(false);
    }
    let (held, name) = (Arc::clone(copies), index_name.to_string());
    off_executor(move || held.apply_stored_settings(&name, &stored.index_uuid, &stored.config))
        .await?
}

fn orphan_report(node_id: &str, index_name: &str, reason: &str) -> ClusterError {
    ClusterError::new(
        codes::INDEX_ORPHANED,
        format!(
            "Node '{node_id}' holds a local copy of index '{index_name}' the cluster does not claim, because \
             {reason}. The node keeps the data and serves none of it until an operator drops it."
        ),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
    .with_detail("nodeId", Value::String(node_id.to_string()))
}

fn unreadable_report(node_id: &str, index_name: &str, reason: &str) -> ClusterError {
    ClusterError::new(
        codes::INDEX_ORPHANED,
        format!(
            "Node '{node_id}' can't confirm that the cluster claims its local copy of index '{index_name}', because \
             {reason}. The node keeps the data and serves none of it until it settles the copy before it registers \
             or at a later start, so keep the copy."
        ),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
    .with_detail("nodeId", Value::String(node_id.to_string()))
}

pub(super) async fn settle_local_indexes(
    coordinator: &EtcdCoordinator,
    copies: &Arc<LocalCopies>,
    node_id: &str,
    on_error: Option<&NodeErrorHandler>,
) -> ClusterResult<()> {
    let held = Arc::clone(copies);
    for index_name in off_executor(move || held.index_names()).await? {
        match settle(coordinator, copies, &index_name).await? {
            Settled::Claimed => {}
            Settled::Orphaned(reason) => {
                copies.mark_orphaned(&index_name, false);
                report_failure(on_error, &orphan_report(node_id, &index_name, &reason));
            }
            Settled::Unreadable(reason) => {
                copies.mark_orphaned(&index_name, true);
                report_failure(on_error, &unreadable_report(node_id, &index_name, &reason));
            }
        }
    }
    Ok(())
}

pub(super) async fn settle_unreadable_indexes(
    coordinator: &EtcdCoordinator,
    copies: &Arc<LocalCopies>,
) -> ClusterResult<()> {
    let mut failure = None;
    for index_name in copies.unreadable_names() {
        let held = Arc::clone(copies);
        let name = index_name.clone();
        if !off_executor(move || held.holds_index(&name)).await? {
            copies.forget_orphan(&index_name);
            continue;
        }
        match settle(coordinator, copies, &index_name).await {
            Ok(Settled::Unreadable(_)) => {}
            Ok(Settled::Orphaned(_)) => copies.mark_orphaned(&index_name, false),
            Ok(Settled::Claimed) => copies.forget_orphan(&index_name),
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
    }
    failure.map_or(Ok(()), Err)
}
