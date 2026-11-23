use std::sync::Arc;

use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use super::departures::DepartureRun;
use super::messages::decoded_fields;
use super::metadata::{IndexMetadata, metadata_key, validate_index_name, validate_record};
use super::placement::nodes_for_each_index;
use super::{Inner, lock};
use crate::allocator::holds_data_role;
use crate::constants::{
    ALLOCATION_DEBOUNCE_MS, MAX_REPLICATION_FACTOR, REPLICATION_FACTOR_CAS_ATTEMPTS,
};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types, refusal};
use crate::node::decode_request_payload;
use crate::transport::Respond;

struct ReplicationFactorRequest {
    index_name: String,
    replication_factor: f64,
}

fn displayed_number(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => format!("{other:?}"),
        None => "undefined".to_string(),
    }
}

fn read_payload(message: &TransportMessage) -> ClusterResult<ReplicationFactorRequest> {
    let decoded = decode_request_payload(&message.payload, &message.message_type)?;
    let named = decoded_fields(&decoded).and_then(|fields| match fields.get("indexName") {
        Some(Value::String(index_name)) => Some((fields, index_name.clone())),
        _ => None,
    });
    let Some((fields, index_name)) = named else {
        return Err(ClusterError::new(
            codes::CONFIG_INVALID,
            "A replication factor request must name an index",
        ));
    };
    match fields.get("replicationFactor") {
        Some(Value::Number(factor))
            if factor.is_finite()
                && factor.fract() == 0.0
                && *factor >= 0.0
                && *factor <= MAX_REPLICATION_FACTOR =>
        {
            Ok(ReplicationFactorRequest {
                index_name,
                replication_factor: *factor,
            })
        }
        other => Err(ClusterError::new(
            codes::CONFIG_INVALID,
            format!(
                "The replication factor of index '{index_name}' must be an integer from 0 to {MAX_REPLICATION_FACTOR}"
            ),
        )
        .with_detail("indexName", Value::String(index_name.clone()))
        .with_detail("replicationFactor", Value::String(displayed_number(other)))),
    }
}

async fn put_index_replication_factor(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    replication_factor: f64,
) -> ClusterResult<Option<IndexMetadata>> {
    validate_index_name(index_name)?;
    let key = metadata_key(index_name);
    for _ in 0..REPLICATION_FACTOR_CAS_ATTEMPTS {
        let Some(raw) = coordinator.get(&key).await? else {
            return Ok(None);
        };
        if raw.is_empty() {
            return Ok(None);
        }
        let decoded = decode_msgpack(&raw).map_err(ClusterError::from)?;
        let record = validate_record(&decoded, index_name)?;
        if record.replication_factor == replication_factor {
            return Ok(Some(record));
        }
        let updated = match decoded {
            Value::Object(mut fields) => {
                fields.insert("replicationFactor", Value::Number(replication_factor));
                Value::Object(fields)
            }
            other => other,
        };
        let encoded = encode_msgpack(&updated).map_err(ClusterError::from)?;
        if coordinator
            .compare_and_set(&key, Some(&raw), &encoded)
            .await?
        {
            return Ok(Some(IndexMetadata {
                replication_factor,
                ..record
            }));
        }
    }
    Err(ClusterError::new(
        codes::ALLOCATION_FAILED,
        format!(
            "The replication factor of index '{index_name}' lost {REPLICATION_FACTOR_CAS_ATTEMPTS} compare-and-set attempts"
        ),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
    .with_detail(
        "attempts",
        Value::Number(REPLICATION_FACTOR_CAS_ATTEMPTS as f64),
    ))
}

fn answer(
    message: &TransportMessage,
    node_id: &str,
    request: &ReplicationFactorRequest,
) -> TransportMessage {
    let mut payload = Map::with_capacity(2);
    payload.insert("indexName", Value::String(request.index_name.clone()));
    payload.insert(
        "replicationFactor",
        Value::Number(request.replication_factor),
    );
    let encoded = encode_msgpack(&Value::Object(payload)).unwrap_or_default();
    TransportMessage::new(
        message_types::CLUSTER_REPLICATION_FACTOR,
        node_id,
        &message.request_id,
        encoded,
    )
}

impl Inner {
    pub(super) async fn allocate_index_now(
        self: &Arc<Self>,
        index_name: &str,
    ) -> ClusterResult<()> {
        if !self.is_active() {
            return Ok(());
        }
        let outcome = self.place_index_now(index_name).await;
        if self.is_active() {
            self.schedule_allocation(ALLOCATION_DEBOUNCE_MS);
        }
        outcome
    }

    async fn place_index_now(&self, index_name: &str) -> ClusterResult<()> {
        let nodes = self.compatible_nodes().await?;
        if !nodes.iter().any(holds_data_role) || !self.is_active() {
            return Ok(());
        }
        let mut departures = DepartureRun::start(&nodes);
        let known = lock(&self.state).known_indexes.clone();
        let nodes_for = nodes_for_each_index(self.coordinator(), nodes, &known).await?;
        let placeable = nodes_for.for_index(index_name);
        if placeable.iter().any(holds_data_role) {
            self.run_for_index(index_name, placeable, Some(&mut departures))
                .await?;
        }
        Ok(())
    }

    async fn apply_replication_factor(
        self: &Arc<Self>,
        message: &TransportMessage,
    ) -> ClusterResult<ReplicationFactorRequest> {
        if !self.is_active() {
            return Err(ClusterError::new(
                codes::NODE_NOT_CONTROLLER,
                format!(
                    "Node '{}' does not hold the controller lease",
                    self.node_id()
                ),
            )
            .with_detail("nodeId", Value::String(self.node_id().to_string())));
        }
        let request = read_payload(message)?;
        let stored = put_index_replication_factor(
            self.coordinator(),
            &request.index_name,
            request.replication_factor,
        )
        .await?;
        if stored.is_none() {
            return Err(ClusterError::new(
                codes::INDEX_NOT_FOUND,
                format!(
                    "Index '{}' has no metadata in the cluster",
                    request.index_name
                ),
            )
            .with_detail("indexName", Value::String(request.index_name.clone())));
        }
        self.allocate_index_now(&request.index_name).await?;
        Ok(request)
    }

    pub(super) fn handle_replication_factor(
        self: &Arc<Self>,
        message: TransportMessage,
        respond: Respond,
    ) {
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            let reply = match inner.apply_replication_factor(&message).await {
                Ok(request) => answer(&message, inner.node_id(), &request),
                Err(error) => refusal(&message, inner.node_id(), &error),
            };
            respond.send(reply).await;
        });
    }
}
