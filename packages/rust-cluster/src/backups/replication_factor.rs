use narsil::{Map, Value};

use super::exchange::{Exchange, exchange_message, node_targets};
use crate::constants::{CONTROLLER_LEASE_KEY, MAX_REPLICATION_FACTOR};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::message_types;
use crate::transport::NodeTransport;

pub(crate) async fn request_replication_factor(
    coordinator: &EtcdCoordinator,
    transport: &dyn NodeTransport,
    node_id: &str,
    index_name: &str,
    replication_factor: f64,
) -> ClusterResult<()> {
    if replication_factor.fract() != 0.0
        || !(0.0..=MAX_REPLICATION_FACTOR).contains(&replication_factor)
    {
        return Err(ClusterError::new(
            codes::CONFIG_INVALID,
            format!(
                "The replication factor of index '{index_name}' must be an integer from 0 to {MAX_REPLICATION_FACTOR}"
            ),
        )
        .with_detail("indexName", Value::from(index_name))
        .with_detail("replicationFactor", Value::String(replication_factor.to_string())));
    }
    let Some(controller_node_id) = coordinator.lease_holder(CONTROLLER_LEASE_KEY).await? else {
        return Err(ClusterError::new(
            codes::NODE_NOT_CONTROLLER,
            format!(
                "No node holds the controller lease, so the replication factor of index '{index_name}' stays as it is"
            ),
        )
        .with_detail("indexName", Value::from(index_name)));
    };
    let mut payload = Map::with_capacity(2);
    payload.insert("indexName", Value::from(index_name));
    payload.insert("replicationFactor", Value::Number(replication_factor));
    let mut details = Map::with_capacity(2);
    details.insert("indexName", Value::from(index_name));
    details.insert("controllerNodeId", Value::from(controller_node_id.as_str()));
    exchange_message(Exchange {
        transport,
        sender_id: node_id,
        targets: node_targets(coordinator, &controller_node_id).await?,
        message_type: message_types::CLUSTER_REPLICATION_FACTOR,
        payload: Value::Object(payload),
        failure_message: format!(
            "The controller '{controller_node_id}' did not answer a replication factor request"
        ),
        details,
    })
    .await
    .map(|_| ())
}
