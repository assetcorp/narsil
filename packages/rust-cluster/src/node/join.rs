use std::sync::Arc;

use narsil::Value;
use tokio::sync::{Notify, watch};

use crate::constants::CONTROLLER_LEASE_KEY;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::coordinator::{NodeEvent, NodeRegistration};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::version::shares_major_version_with;

pub(crate) async fn refuse_controller_on_another_major_version(
    coordinator: &EtcdCoordinator,
    registration: &NodeRegistration,
) -> ClusterResult<()> {
    let node_id = registration.node_id.as_str();
    let Some(controller_node_id) = coordinator.lease_holder(CONTROLLER_LEASE_KEY).await? else {
        return Ok(());
    };
    if controller_node_id == node_id {
        return Ok(());
    }
    let nodes = coordinator.list_nodes().await?;
    let Some(controller) = nodes.iter().find(|node| node.node_id == controller_node_id) else {
        return Ok(());
    };
    if shares_major_version_with(&controller.version, &registration.version) {
        return Ok(());
    }
    let version = registration.version.as_str();
    let controller_version = controller.version.as_str();
    Err(ClusterError::new(
        codes::NODE_VERSION_INCOMPATIBLE,
        format!(
            "Node '{node_id}' follows specification version {version}, and the active controller \
             '{controller_node_id}' follows {controller_version}, which has another major version"
        ),
    )
    .with_detail("nodeId", Value::String(node_id.to_string()))
    .with_detail("version", Value::String(version.to_string()))
    .with_detail(
        "controllerNodeId",
        Value::String(controller_node_id.clone()),
    )
    .with_detail(
        "controllerVersion",
        Value::String(controller_version.to_string()),
    ))
}

fn aborted_join(node_id: &str) -> ClusterError {
    ClusterError::new(
        codes::NODE_NOT_JOINED,
        format!("Node '{node_id}' shut down while it waited for its earlier registration to lapse"),
    )
    .with_detail("nodeId", Value::String(node_id.to_string()))
}

pub(crate) async fn wait_for_earlier_registration_to_lapse(
    coordinator: &EtcdCoordinator,
    node_id: &str,
    stopping: &mut watch::Receiver<bool>,
) -> ClusterResult<()> {
    if *stopping.borrow() {
        return Err(aborted_join(node_id));
    }
    let lapsed = Arc::new(Notify::new());
    let marker = Arc::clone(&lapsed);
    let watched_id = node_id.to_string();
    let watch = coordinator
        .watch_nodes(move |event| {
            if matches!(&event, NodeEvent::Left(left_id) if *left_id == watched_id) {
                marker.notify_one();
            }
        })
        .await?;
    let outcome = async {
        let registered = coordinator.list_nodes().await?;
        if registered.iter().any(|node| node.node_id == node_id) {
            tokio::select! {
                () = lapsed.notified() => {}
                _ = stopping.wait_for(|stopped| *stopped) => return Err(aborted_join(node_id)),
            }
        }
        if *stopping.borrow() {
            return Err(aborted_join(node_id));
        }
        Ok(())
    }
    .await;
    watch.stop();
    outcome
}
