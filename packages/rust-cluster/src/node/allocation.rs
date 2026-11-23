use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use super::handle::ClusterNode;
use super::identity::generate_node_id;
use crate::constants::{CONTROLLER_LEASE_KEY, MAX_REPLICATION_FACTOR};
use crate::coordinator::AllocationTable;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types};

const ERROR_MESSAGE_SUFFIX: &str = ".error";

fn transport_failure(error: &ClusterError, message: &str, details: &Map) -> ClusterError {
    let code = match error.code() {
        codes::TRANSPORT_CONNECT_FAILED | codes::TRANSPORT_PEER_UNAVAILABLE => {
            codes::QUERY_NO_ACTIVE_REPLICA
        }
        codes::TRANSPORT_TIMEOUT => codes::QUERY_NODE_TIMEOUT,
        codes::TRANSPORT_MESSAGE_TOO_LARGE | codes::TRANSPORT_DECODE_FAILED => {
            codes::QUERY_ROUTING_FAILED
        }
        _ => return error.clone(),
    };
    let mut failure = ClusterError::new(code, message);
    for (key, value) in details.iter() {
        failure = failure.with_detail(key, value.clone());
    }
    failure.with_detail("transportCode", Value::from(error.code()))
}

fn factor_refusal(index_name: &str, replication_factor: f64) -> Option<ClusterError> {
    let whole = replication_factor.is_finite() && replication_factor.fract() == 0.0;
    if whole && (0.0..=MAX_REPLICATION_FACTOR).contains(&replication_factor) {
        return None;
    }
    Some(
        ClusterError::new(
            codes::CONFIG_INVALID,
            format!(
                "The replication factor of index '{index_name}' must be an integer from 0 to {MAX_REPLICATION_FACTOR}"
            ),
        )
        .with_detail("indexName", Value::from(index_name))
        .with_detail(
            "replicationFactor",
            Value::String(format!("{replication_factor}")),
        ),
    )
}

fn controller_answer(
    response: &TransportMessage,
    index_name: &str,
    controller_node_id: &str,
) -> ClusterResult<()> {
    let located = |error: ClusterError| {
        error
            .with_detail("indexName", Value::from(index_name))
            .with_detail("controllerNodeId", Value::from(controller_node_id))
    };
    let Ok(Value::Object(reply)) = decode_msgpack(&response.payload) else {
        return Err(located(ClusterError::new(
            codes::ALLOCATION_FAILED,
            format!("The controller sent an unreadable answer for '{index_name}'"),
        )));
    };
    let refused = response.message_type.ends_with(ERROR_MESSAGE_SUFFIX)
        || matches!(reply.get("error"), Some(Value::Bool(true)));
    if !refused {
        return Ok(());
    }
    let text = |key: &str| reply.get(key).and_then(Value::as_str);
    let mut error = ClusterError::new(
        text("code").unwrap_or(codes::ALLOCATION_FAILED),
        text("message").unwrap_or("The controller refused the replication factor"),
    );
    if let Some(Value::Object(remote)) = reply.get("details") {
        for (key, value) in remote.iter() {
            error = error.with_detail(key, value.clone());
        }
    }
    Err(located(error))
}

impl ClusterNode {
    /// Returns the allocation table of `index_name` as etcd holds it, read through the generation that serves the
    /// name while a partition count change has moved it, or `None` where the cluster holds no table for it.
    ///
    /// # Errors
    ///
    /// Fails with the coordinator's error where etcd cannot be read.
    pub async fn allocation(&self, index_name: &str) -> ClusterResult<Option<AllocationTable>> {
        let coordinator = self.inner.coordinator();
        let Some(table) = coordinator.allocation(index_name).await? else {
            return Ok(None);
        };
        let Some(generation) = table.generation.clone() else {
            return Ok(Some(table));
        };
        Ok(coordinator
            .allocation(&generation)
            .await?
            .map(|served| AllocationTable {
                index_name: index_name.to_string(),
                ..served
            }))
    }

    /// Asks the node that holds the controller lease to keep `replication_factor` replicas of every partition of
    /// `index_name`, and returns once the controller records the change, before it places the new replicas.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` for a factor that is not an integer from 0 to 255, with `NODE_NOT_CONTROLLER`
    /// where no node holds the controller lease, with `QUERY_NO_ACTIVE_REPLICA` or `QUERY_NODE_TIMEOUT` where the
    /// controller cannot be reached, and with the controller's refusal otherwise, such as `INDEX_NOT_FOUND`.
    pub async fn set_replication_factor(
        &self,
        index_name: &str,
        replication_factor: f64,
    ) -> ClusterResult<()> {
        let serving = self.serving_name(index_name).await?;
        if let Some(refusal) = factor_refusal(&serving, replication_factor) {
            return Err(refusal);
        }
        let coordinator = self.inner.coordinator();
        let Some(controller_node_id) = coordinator.lease_holder(CONTROLLER_LEASE_KEY).await? else {
            return Err(ClusterError::new(
                codes::NODE_NOT_CONTROLLER,
                format!(
                    "No node holds the controller lease, so the replication factor of index '{serving}' stays as it is"
                ),
            )
            .with_detail("indexName", Value::from(serving.as_str())));
        };
        let mut payload = Map::with_capacity(2);
        payload.insert("indexName", Value::from(serving.as_str()));
        payload.insert("replicationFactor", Value::Number(replication_factor));
        let message = TransportMessage::new(
            message_types::CLUSTER_REPLICATION_FACTOR,
            self.node_id(),
            generate_node_id()?,
            encode_msgpack(&Value::Object(payload)).map_err(ClusterError::from)?,
        );
        let failure_message = format!(
            "The controller '{controller_node_id}' did not answer a replication factor request"
        );
        let mut details = Map::with_capacity(3);
        details.insert("indexName", Value::from(serving.as_str()));
        details.insert("targetNodeId", Value::from(controller_node_id.as_str()));
        let mut last_error = None;
        for target in self.resolve_node_targets(&controller_node_id).await? {
            match self.inner.transport().send(&target, message.clone()).await {
                Ok(response) => {
                    return controller_answer(&response, &serving, &controller_node_id);
                }
                Err(error) => last_error = Some(error),
            }
        }
        Err(match last_error {
            Some(error) => transport_failure(&error, &failure_message, &details),
            None => ClusterError::new(codes::QUERY_NO_ACTIVE_REPLICA, failure_message),
        })
    }
}
