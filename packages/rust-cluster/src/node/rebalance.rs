use std::time::Duration;

use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use super::handle::ClusterNode;
use super::identity::generate_node_id;
use super::member::node_error;
use crate::constants::{
    CONTROLLER_LEASE_KEY, HIDDEN_GENERATION_PREFIX, MAX_PARTITION_COUNT,
    RESHARD_CONTROLLER_POLL_INTERVAL_MS,
};
use crate::controller::rebalance_record_key;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types};

const ERROR_MESSAGE_SUFFIX: &str = ".error";

struct RebalanceJob {
    job_id: String,
    target_generation: String,
}

pub(super) fn refuse_hidden_generation(index_name: &str) -> ClusterResult<()> {
    if !index_name.starts_with(HIDDEN_GENERATION_PREFIX) {
        return Ok(());
    }
    Err(ClusterError::new(
        codes::CONFIG_INVALID,
        format!(
            "Index names that start with '{HIDDEN_GENERATION_PREFIX}' are reserved for partition count changes"
        ),
    )
    .with_detail("indexName", Value::from(index_name)))
}

fn remote_details(reply: &Map) -> Map {
    match reply.get("details") {
        Some(Value::Object(details)) => details.clone(),
        _ => Map::new(),
    }
}

fn decode_rebalance_reply(
    response: &TransportMessage,
    failure_message: &str,
    details: &Map,
) -> ClusterResult<Map> {
    let with_details = |mut error: ClusterError, extra: &Map| {
        for (key, value) in extra.iter() {
            error = error.with_detail(key, value.clone());
        }
        error
    };
    let Ok(Value::Object(reply)) = decode_msgpack(&response.payload) else {
        let error = ClusterError::new(
            codes::ALLOCATION_FAILED,
            format!("{failure_message}: the answer was unreadable"),
        );
        return Err(with_details(error, details));
    };
    let refused = response.message_type.ends_with(ERROR_MESSAGE_SUFFIX)
        || matches!(reply.get("error"), Some(Value::Bool(true)));
    if !refused {
        return Ok(reply);
    }
    let text = |key: &str| reply.get(key).and_then(Value::as_str);
    let error = ClusterError::new(
        text("code").unwrap_or(codes::ALLOCATION_FAILED),
        text("message").unwrap_or(failure_message),
    );
    let error = with_details(error, &remote_details(&reply));
    Err(with_details(error, details))
}

impl ClusterNode {
    fn guard_shutdown(&self) -> ClusterResult<()> {
        if !self.inner.is_stopping() {
            return Ok(());
        }
        let node_id = self.node_id();
        Err(node_error(
            codes::NODE_NOT_JOINED,
            format!("Cluster node '{node_id}' has been shut down"),
            node_id,
        ))
    }

    async fn resolve_node_targets(&self, target_node_id: &str) -> ClusterResult<Vec<String>> {
        let nodes = self.inner.coordinator().list_nodes().await?;
        let address = nodes
            .iter()
            .find(|node| node.node_id == target_node_id)
            .map(|node| node.address.as_str());
        Ok(match address {
            Some(address) if !address.is_empty() && address != target_node_id => {
                vec![address.to_string(), target_node_id.to_string()]
            }
            _ => vec![target_node_id.to_string()],
        })
    }

    async fn request_rebalance(
        &self,
        index_name: &str,
        target_partition_count: u64,
    ) -> ClusterResult<RebalanceJob> {
        refuse_hidden_generation(index_name)?;
        if target_partition_count < 1 || target_partition_count as f64 > MAX_PARTITION_COUNT {
            return Err(ClusterError::new(
                codes::CONFIG_INVALID,
                format!(
                    "The partition count of index '{index_name}' must be an integer from 1 to {MAX_PARTITION_COUNT}"
                ),
            )
            .with_detail("indexName", Value::from(index_name))
            .with_detail(
                "targetPartitionCount",
                Value::String(target_partition_count.to_string()),
            ));
        }
        let Some(controller_node_id) = self
            .inner
            .coordinator()
            .lease_holder(CONTROLLER_LEASE_KEY)
            .await?
        else {
            return Err(ClusterError::new(
                codes::NODE_NOT_CONTROLLER,
                format!(
                    "No node holds the controller lease, so index '{index_name}' keeps its partition count"
                ),
            )
            .with_detail("indexName", Value::from(index_name)));
        };
        let mut payload = Map::with_capacity(2);
        payload.insert("indexName", Value::from(index_name));
        payload.insert(
            "targetPartitionCount",
            Value::Number(target_partition_count as f64),
        );
        let message = TransportMessage::new(
            message_types::CLUSTER_REBALANCE,
            self.node_id(),
            generate_node_id()?,
            encode_msgpack(&Value::Object(payload)).map_err(ClusterError::from)?,
        );
        let failure_message = format!(
            "The controller '{controller_node_id}' did not answer a partition count change"
        );
        let mut details = Map::with_capacity(2);
        details.insert("indexName", Value::from(index_name));
        details.insert("controllerNodeId", Value::from(controller_node_id.as_str()));
        let mut last_error = ClusterError::new(codes::QUERY_NO_ACTIVE_REPLICA, &failure_message);
        for target in self.resolve_node_targets(&controller_node_id).await? {
            match self.inner.transport().send(&target, message.clone()).await {
                Ok(response) => {
                    let reply = decode_rebalance_reply(&response, &failure_message, &details)?;
                    let text = |key: &str| reply.get(key).and_then(Value::as_str);
                    return match (text("jobId"), text("targetGeneration")) {
                        (Some(job_id), Some(target_generation)) => Ok(RebalanceJob {
                            job_id: job_id.to_string(),
                            target_generation: target_generation.to_string(),
                        }),
                        _ => Err(ClusterError::new(
                            codes::ALLOCATION_FAILED,
                            format!(
                                "The controller sent an unreadable answer to the partition count change of '{index_name}'"
                            ),
                        )
                        .with_detail("indexName", Value::from(index_name))
                        .with_detail("controllerNodeId", Value::from(controller_node_id.as_str()))),
                    };
                }
                Err(error) => {
                    last_error =
                        ClusterError::new(codes::QUERY_NO_ACTIVE_REPLICA, &failure_message)
                            .with_detail("indexName", Value::from(index_name))
                            .with_detail(
                                "controllerNodeId",
                                Value::from(controller_node_id.as_str()),
                            )
                            .with_detail("transportCode", Value::from(error.code()));
                }
            }
        }
        Err(last_error)
    }

    async fn serving_generation(&self, index_name: &str) -> ClusterResult<Option<String>> {
        Ok(self
            .inner
            .coordinator()
            .allocation(index_name)
            .await?
            .and_then(|table| table.generation))
    }

    async fn running_job_id(&self, index_name: &str) -> ClusterResult<Option<String>> {
        let Some(bytes) = self
            .inner
            .coordinator()
            .get(&rebalance_record_key(index_name))
            .await?
        else {
            return Ok(None);
        };
        if bytes.is_empty() {
            return Ok(None);
        }
        match decode_msgpack(&bytes) {
            Ok(Value::Object(record)) => Ok(record
                .get("jobId")
                .and_then(Value::as_str)
                .map(str::to_string)),
            _ => Ok(None),
        }
    }

    async fn wait_for_swap(&self, index_name: &str, job: &RebalanceJob) -> ClusterResult<()> {
        loop {
            self.guard_shutdown()?;
            let target = Some(job.target_generation.as_str());
            if self.serving_generation(index_name).await?.as_deref() == target {
                return Ok(());
            }
            let running = self.running_job_id(index_name).await?;
            if running.as_deref() != Some(job.job_id.as_str()) {
                if self.serving_generation(index_name).await?.as_deref() == target {
                    return Ok(());
                }
                return Err(ClusterError::new(
                    codes::ALLOCATION_FAILED,
                    format!(
                        "The partition count change of index '{index_name}' was aborted, so the index keeps its partitions"
                    ),
                )
                .with_detail("indexName", Value::from(index_name))
                .with_detail("jobId", Value::from(job.job_id.as_str())));
            }
            tokio::time::sleep(Duration::from_millis(RESHARD_CONTROLLER_POLL_INTERVAL_MS)).await;
        }
    }

    /// Moves an index onto a new number of partitions, and returns once every read and write of the index goes to
    /// the new layout.
    ///
    /// The node sends `cluster.rebalance` to the node that holds the controller lease, which copies every document
    /// into a hidden index with the new partition count while the current layout keeps serving, and moves the index
    /// name onto the new layout in a single allocation write. The node then polls the allocation table until it
    /// names the new layout.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` for a count outside 1 to 65,536, for a count equal to the current one, or for a
    /// name that starts with `narsil-generation-`, with `INDEX_NOT_FOUND` where the cluster holds no such index,
    /// with `PARTITION_REBALANCING_BACKPRESSURE` while another change to the same index runs, with
    /// `NODE_NOT_CONTROLLER` where no node holds the controller lease, with `QUERY_NO_ACTIVE_REPLICA` where the
    /// controller cannot be reached, with `ALLOCATION_FAILED` where the controller aborts the change, and with
    /// `NODE_NOT_JOINED` where the node shuts down while it waits.
    pub async fn rebalance(
        &self,
        index_name: &str,
        target_partition_count: u64,
    ) -> ClusterResult<()> {
        self.guard_shutdown()?;
        let job = self
            .request_rebalance(index_name, target_partition_count)
            .await?;
        self.wait_for_swap(index_name, &job).await
    }
}
