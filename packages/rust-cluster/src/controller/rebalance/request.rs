use std::sync::Arc;

use narsil::{Map, Value, encode_msgpack};

use crate::constants::MAX_PARTITION_COUNT;
use crate::controller::messages::decoded_fields;
use crate::controller::{Inner, index_metadata, stored_index_metadata, stored_table};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types, refusal};
use crate::node::{decode_request_payload, generate_node_id};
use crate::rebalance::{
    RebalancePhase, RebalanceRecord, create_rebalance_record, generation_name_of,
    is_hidden_generation, read_rebalance_record, update_rebalance_record,
};
use crate::transport::Respond;

struct RebalanceRequest {
    index_name: String,
    target_partition_count: u64,
}

fn displayed(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => format!("{other:?}"),
        None => "undefined".to_string(),
    }
}

fn read_payload(message: &TransportMessage) -> ClusterResult<RebalanceRequest> {
    let decoded = decode_request_payload(&message.payload, &message.message_type)?;
    let named = decoded_fields(&decoded).and_then(|fields| match fields.get("indexName") {
        Some(Value::String(index_name)) if !index_name.is_empty() => {
            Some((fields, index_name.clone()))
        }
        _ => None,
    });
    let Some((fields, index_name)) = named else {
        return Err(ClusterError::new(
            codes::CONFIG_INVALID,
            "A partition count change must name an index",
        ));
    };
    let target_partition_count = match fields.get("targetPartitionCount") {
        Some(Value::Number(count))
            if count.is_finite()
                && count.fract() == 0.0
                && *count >= 1.0
                && *count <= MAX_PARTITION_COUNT =>
        {
            *count as u64
        }
        other => {
            return Err(ClusterError::new(
                codes::CONFIG_INVALID,
                format!(
                    "The partition count of index '{index_name}' must be an integer from 1 to {MAX_PARTITION_COUNT}"
                ),
            )
            .with_detail("indexName", Value::String(index_name.clone()))
            .with_detail("targetPartitionCount", Value::String(displayed(other))));
        }
    };
    if is_hidden_generation(&index_name) {
        return Err(ClusterError::new(
            codes::CONFIG_INVALID,
            format!("Index '{index_name}' is a hidden partition layout"),
        )
        .with_detail("indexName", Value::String(index_name)));
    }
    Ok(RebalanceRequest {
        index_name,
        target_partition_count,
    })
}

fn index_not_found(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::INDEX_NOT_FOUND,
        format!("Index '{index_name}' has no metadata in the cluster"),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
}

fn backpressure(message: String, index_name: &str) -> ClusterError {
    ClusterError::new(codes::PARTITION_REBALANCING_BACKPRESSURE, message)
        .with_detail("indexName", Value::String(index_name.to_string()))
}

impl Inner {
    async fn record_rebalance(self: &Arc<Self>, message: &TransportMessage) -> ClusterResult<Map> {
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
        let index_name = request.index_name.as_str();
        if index_metadata(self.coordinator(), index_name)
            .await?
            .is_none()
        {
            return Err(index_not_found(index_name));
        }
        let source_generation = stored_table(self.coordinator(), index_name)
            .await?
            .and_then(|table| table.generation)
            .unwrap_or_else(|| index_name.to_string());
        let Some(source) = index_metadata(self.coordinator(), &source_generation).await? else {
            return Err(index_not_found(index_name));
        };
        if source.partition_count == request.target_partition_count as f64 {
            return Err(ClusterError::new(
                codes::CONFIG_INVALID,
                format!(
                    "Index '{index_name}' already has {} partitions",
                    request.target_partition_count
                ),
            )
            .with_detail("indexName", Value::String(index_name.to_string()))
            .with_detail(
                "targetPartitionCount",
                Value::Number(request.target_partition_count as f64),
            ));
        }
        let record = RebalanceRecord {
            job_id: generate_node_id()?,
            source_generation: source_generation.clone(),
            target_generation: generation_name_of(&generate_node_id()?),
            target_partition_count: request.target_partition_count,
            phase: RebalancePhase::Copying,
            cutover_attempts: 0,
        };
        if !create_rebalance_record(self.coordinator(), index_name, &record).await? {
            let running = read_rebalance_record(self.coordinator(), index_name).await?;
            if let Some(running) = &running {
                self.start_rebalance_driver(index_name, &running.job_id);
            }
            return Err(backpressure(
                format!("Index '{index_name}' is already changing its partition count"),
                index_name,
            )
            .with_detail(
                "jobId",
                running.map_or(Value::Null, |running| Value::String(running.job_id)),
            ));
        }
        let pending_analysis = stored_index_metadata(self.coordinator(), &source_generation)
            .await?
            .and_then(|(_, settings)| match settings {
                Some(Value::Object(settings)) => settings.get("pendingAnalysis").cloned(),
                _ => None,
            })
            .is_some();
        if pending_analysis {
            update_rebalance_record(self.coordinator(), index_name, &record.job_id, |_| None)
                .await?;
            return Err(backpressure(
                format!(
                    "Index '{index_name}' is changing its analysis, so try its partition count change again once that ends"
                ),
                index_name,
            ));
        }
        self.start_rebalance_driver(index_name, &record.job_id);
        let mut result = Map::with_capacity(3);
        result.insert("indexName", Value::String(index_name.to_string()));
        result.insert("jobId", Value::String(record.job_id));
        result.insert("targetGeneration", Value::String(record.target_generation));
        Ok(result)
    }

    pub(in crate::controller) fn handle_rebalance(
        self: &Arc<Self>,
        message: TransportMessage,
        respond: Respond,
    ) {
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            let reply = match inner.record_rebalance(&message).await {
                Ok(result) => TransportMessage::new(
                    message_types::CLUSTER_REBALANCE,
                    inner.node_id(),
                    &message.request_id,
                    encode_msgpack(&Value::Object(result)).unwrap_or_default(),
                ),
                Err(error) => refusal(&message, inner.node_id(), &error),
            };
            respond.send(reply).await;
        });
    }

    pub(in crate::controller) async fn resume_rebalance(self: &Arc<Self>, index_name: &str) {
        if is_hidden_generation(index_name) || !self.is_active() {
            return;
        }
        match read_rebalance_record(self.coordinator(), index_name).await {
            Ok(Some(record)) => self.start_rebalance_driver(index_name, &record.job_id),
            Ok(None) => {}
            Err(error) => self.report(index_name, &error),
        }
    }

    pub(in crate::controller) async fn resume_rebalances(self: &Arc<Self>) -> ClusterResult<()> {
        for index_name in self.coordinator().list_schemas().await? {
            self.resume_rebalance(&index_name).await;
        }
        Ok(())
    }
}
