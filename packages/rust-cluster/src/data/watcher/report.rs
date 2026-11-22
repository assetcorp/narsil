use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use super::WatcherContext;
use super::state::PartitionKey;
use crate::allocator::{INITIALISING, Table};
use crate::constants::CONTROLLER_LEASE_KEY;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types};
use crate::node::generate_node_id;

impl WatcherContext {
    pub(super) async fn live_table(&self, index_name: &str) -> ClusterResult<Option<Table>> {
        Ok(self
            .coordinator
            .allocation(index_name)
            .await?
            .map(|stored| Table::from_stored(&stored)))
    }

    pub(super) async fn awaits_bootstrap_report(&self, key: &PartitionKey) -> bool {
        match self.live_table(&key.0).await {
            Ok(Some(table)) => table
                .assignments
                .get(f64::from(key.1))
                .is_none_or(|assignment| assignment.state == INITIALISING),
            Ok(None) | Err(_) => true,
        }
    }

    pub(super) async fn node_targets(&self, node_id: &str) -> Vec<String> {
        let mut targets = vec![node_id.to_string()];
        if let Ok(nodes) = self.coordinator.list_nodes().await
            && let Some(node) = nodes.iter().find(|node| node.node_id == node_id)
            && !node.address.is_empty()
            && node.address != node_id
        {
            targets.push(node.address.clone());
        }
        targets
    }

    fn completion_report(
        &self,
        key: &PartitionKey,
        primary_term: f64,
    ) -> ClusterResult<TransportMessage> {
        let mut payload = Map::with_capacity(4);
        payload.insert("indexName", Value::String(key.0.clone()));
        payload.insert("partitionId", Value::from(key.1));
        payload.insert("nodeId", Value::String(self.node_id.clone()));
        payload.insert("primaryTerm", Value::Number(primary_term));
        let encoded = encode_msgpack(&Value::Object(payload))?;
        Ok(TransportMessage::new(
            message_types::CLUSTER_BOOTSTRAP_COMPLETE,
            self.node_id.as_str(),
            generate_node_id()?,
            encoded,
        ))
    }

    pub(super) async fn report_bootstrap_complete(
        &self,
        key: &PartitionKey,
    ) -> ClusterResult<bool> {
        let Some(controller_node_id) = self.coordinator.lease_holder(CONTROLLER_LEASE_KEY).await?
        else {
            return Ok(false);
        };
        let Some(table) = self.live_table(&key.0).await? else {
            return Ok(false);
        };
        let Some(assignment) = table.assignments.get(f64::from(key.1)) else {
            return Ok(false);
        };
        let report = self.completion_report(key, assignment.primary_term)?;
        let mut send_failure = None;
        for target in self.node_targets(&controller_node_id).await {
            match self.transport.send(&target, report.clone()).await {
                Ok(answer) => return completion_answer(&answer, &controller_node_id),
                Err(error) => send_failure = Some(error),
            }
        }
        Err(send_failure.unwrap_or_else(|| {
            ClusterError::new(
                codes::TRANSPORT_CONNECT_FAILED,
                format!("Controller '{controller_node_id}' has no address to report to"),
            )
        }))
    }
}

fn completion_answer(answer: &TransportMessage, controller_node_id: &str) -> ClusterResult<bool> {
    let Ok(Value::Object(fields)) = decode_msgpack(&answer.payload) else {
        return Ok(false);
    };
    if !answer.is_failure() {
        return Ok(matches!(fields.get("accepted"), Some(Value::Bool(true))));
    }
    let code = match fields.get("code") {
        Some(Value::String(code)) if !code.is_empty() => code.clone(),
        _ => return Ok(false),
    };
    let message = match fields.get("message") {
        Some(Value::String(message)) => message.clone(),
        _ => format!("Controller '{controller_node_id}' refused the bootstrap completion report"),
    };
    Err(ClusterError::new(code, message).with_detail(
        "controllerNodeId",
        Value::String(controller_node_id.to_string()),
    ))
}
