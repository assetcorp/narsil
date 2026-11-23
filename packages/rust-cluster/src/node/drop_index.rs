use std::sync::Arc;
use std::time::{Duration, Instant};

use narsil::{Map, Value, decode_msgpack, encode_msgpack};
use tokio::task::JoinSet;

use super::handle::ClusterNode;
use super::identity::generate_node_id;
use super::member::NodeInner;
use super::rebalance::{refuse_hidden_generation, resolve_node_targets};
use crate::constants::{DROP_ACKNOWLEDGE_POLL_INTERVAL_MS, MAX_DROP_ACKNOWLEDGE_WAIT_MS};
use crate::controller::{clear_every_progress, metadata_key, validate_index_name};
use crate::data::synonym_set::{delete_synonym_set, stored_synonym_set_of};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types};
use crate::rebalance::{RebalancePhase, read_rebalance_record, update_rebalance_record};

const DATA_ROLE: &str = "data";
const INSTANCE_SHUT_DOWN: &str = "INSTANCE_SHUT_DOWN";

struct DroppedClusterIndex {
    index_uuid: Option<String>,
}

fn local_index_is_gone(error: &ClusterError) -> bool {
    error.code() == codes::INDEX_NOT_FOUND || error.code() == INSTANCE_SHUT_DOWN
}

fn index_uuid_of_stored_metadata(bytes: &[u8]) -> Option<String> {
    match decode_msgpack(bytes) {
        Ok(Value::Object(fields)) => fields
            .get("indexUuid")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

fn stores_request(index_name: &str, sender_id: &str) -> ClusterResult<TransportMessage> {
    let mut payload = Map::with_capacity(1);
    payload.insert("indexName", Value::from(index_name));
    Ok(TransportMessage::new(
        message_types::CLUSTER_PARTITION_STORES,
        sender_id,
        generate_node_id()?,
        encode_msgpack(&Value::Object(payload))?,
    ))
}

fn answer_holds_copy(answer: &TransportMessage, index_name: &str, dropped: Option<&str>) -> bool {
    let Ok(Value::Object(fields)) = decode_msgpack(&answer.payload) else {
        return true;
    };
    let well_formed_ids = matches!(fields.get("partitionIds"), Some(Value::Array(ids))
        if ids.iter().all(|id| matches!(id, Value::Number(id) if id.fract() == 0.0 && *id >= 0.0)));
    let answered_uuid = match fields.get("indexUuid") {
        None | Some(Value::Null) => None,
        Some(Value::String(uuid)) => Some(uuid.as_str()),
        Some(_) => return true,
    };
    if !well_formed_ids || fields.get("indexName").and_then(Value::as_str) != Some(index_name) {
        return true;
    }
    match dropped {
        None => answered_uuid.is_some(),
        Some(dropped) => answered_uuid == Some(dropped),
    }
}

struct CopyQuestion {
    inner: Arc<NodeInner>,
    node_id: String,
    index_name: String,
    dropped: Option<String>,
}

impl CopyQuestion {
    async fn holds_copy(self) -> bool {
        let dropped = self.dropped.as_deref();
        if self.node_id == self.inner.node_id() {
            return match &self.inner.data {
                Some(data) => data
                    .holds_local_copy(&self.index_name, dropped)
                    .await
                    .unwrap_or(true),
                None => false,
            };
        }
        let Ok(request) = stores_request(&self.index_name, self.inner.node_id()) else {
            return true;
        };
        let Ok(targets) = resolve_node_targets(self.inner.coordinator(), &self.node_id).await
        else {
            return true;
        };
        for target in targets {
            if let Ok(answer) = self.inner.transport().send(&target, request.clone()).await {
                return answer_holds_copy(&answer, &self.index_name, dropped);
            }
        }
        true
    }
}

impl ClusterNode {
    pub(super) async fn delete_stored_synonym_set(&self, metadata: &[u8]) -> ClusterResult<()> {
        match stored_synonym_set_of(metadata) {
            Some((index_uuid, reference)) => {
                delete_synonym_set(self.inner.coordinator(), &index_uuid, &reference).await
            }
            None => Ok(()),
        }
    }

    async fn drop_local_index(&self, index_name: &str, when_listed: bool) -> ClusterResult<()> {
        match &self.inner.data {
            Some(data) => data.drop_local_index(index_name, when_listed).await,
            None if when_listed => Ok(()),
            None => Err(ClusterError::new(
                codes::INDEX_NOT_FOUND,
                format!("Index '{index_name}' does not exist"),
            )
            .with_detail("indexName", Value::from(index_name))),
        }
    }

    async fn route_drop_index(
        &self,
        index_name: &str,
    ) -> ClusterResult<Option<DroppedClusterIndex>> {
        validate_index_name(index_name)?;
        let coordinator = self.inner.coordinator();
        let key = metadata_key(index_name);
        let metadata = coordinator.get(&key).await?;
        let stored = metadata.as_deref().filter(|bytes| !bytes.is_empty());
        let schema = coordinator.schema(index_name).await?;
        if stored.is_none() && schema.is_none() {
            if metadata.is_none() {
                self.drop_local_index(index_name, false).await?;
                return Ok(None);
            }
            self.drop_local_index(index_name, true).await?;
            return Ok(Some(DroppedClusterIndex { index_uuid: None }));
        }
        let mut index_uuid = None;
        if let Some(bytes) = stored {
            if !coordinator.compare_and_set(&key, Some(bytes), &[]).await? {
                return Err(ClusterError::new(
                    codes::CONFIG_INVALID,
                    format!(
                        "Index '{index_name}' changed while it was being dropped; retry the drop"
                    ),
                )
                .with_detail("indexName", Value::from(index_name)));
            }
            index_uuid = index_uuid_of_stored_metadata(bytes);
            self.delete_stored_synonym_set(bytes).await?;
        }
        coordinator.drop_schema(index_name).await?;
        Ok(Some(DroppedClusterIndex { index_uuid }))
    }

    async fn drop_generation_name(&self, generation: &str) -> ClusterResult<()> {
        match self.route_drop_index(generation).await {
            Err(error) if !local_index_is_gone(&error) => Err(error),
            _ => Ok(()),
        }
    }

    async fn drop_served_index(
        &self,
        index_name: &str,
    ) -> ClusterResult<Option<DroppedClusterIndex>> {
        let coordinator = self.inner.coordinator();
        if let Some(record) = read_rebalance_record(coordinator, index_name).await? {
            update_rebalance_record(coordinator, index_name, &record.job_id, |current| {
                let mut aborting = current.clone();
                aborting.phase = RebalancePhase::Aborting;
                Some(aborting)
            })
            .await?;
            let source = coordinator.allocation(&record.source_generation).await?;
            self.drop_generation_name(&record.target_generation).await?;
            let source_partitions = source.map_or(0, |table| table.assignments.len());
            clear_every_progress(coordinator, index_name, source_partitions).await?;
            update_rebalance_record(coordinator, index_name, &record.job_id, |_| None).await?;
        }
        let generation = coordinator
            .allocation(index_name)
            .await?
            .and_then(|table| table.generation);
        if let Some(generation) = generation {
            self.drop_generation_name(&generation).await?;
        }
        self.route_drop_index(index_name).await
    }

    async fn nodes_holding_copies(
        &self,
        index_name: &str,
        dropped: Option<&str>,
    ) -> ClusterResult<Vec<String>> {
        let mut node_ids = vec![self.node_id().to_string()];
        for node in self.inner.coordinator().list_nodes().await? {
            if node.roles.iter().any(|role| role == DATA_ROLE) && !node_ids.contains(&node.node_id)
            {
                node_ids.push(node.node_id);
            }
        }
        let mut asks = JoinSet::new();
        for (position, node_id) in node_ids.iter().enumerate() {
            let ask = CopyQuestion {
                inner: Arc::clone(&self.inner),
                node_id: node_id.clone(),
                index_name: index_name.to_string(),
                dropped: dropped.map(str::to_string),
            };
            asks.spawn(async move { (position, ask.holds_copy().await) });
        }
        let mut holding = vec![true; node_ids.len()];
        while let Some(finished) = asks.join_next().await {
            if let Ok((position, holds)) = finished {
                holding[position] = holds;
            }
        }
        Ok(node_ids
            .into_iter()
            .zip(holding)
            .filter_map(|(node_id, holds)| holds.then_some(node_id))
            .collect())
    }

    async fn table_of_dropped_index(
        &self,
        index_name: &str,
        dropped: Option<&str>,
    ) -> ClusterResult<bool> {
        let Some(table) = self.inner.coordinator().allocation(index_name).await? else {
            return Ok(false);
        };
        Ok(match (dropped, table.index_uuid.as_deref()) {
            (None, _) | (_, None) => true,
            (Some(dropped), Some(uuid)) => dropped == uuid,
        })
    }

    async fn await_drop_acknowledgement(
        &self,
        index_name: &str,
        dropped: Option<&str>,
    ) -> ClusterResult<()> {
        let deadline = Instant::now() + Duration::from_millis(MAX_DROP_ACKNOWLEDGE_WAIT_MS);
        loop {
            let table_remains = self.table_of_dropped_index(index_name, dropped).await?;
            let holders = self.nodes_holding_copies(index_name, dropped).await?;
            if !table_remains && holders.is_empty() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                let pending = if table_remains {
                    "its allocation table is still stored and "
                } else {
                    ""
                };
                return Err(ClusterError::new(
                    codes::QUERY_NODE_TIMEOUT,
                    format!(
                        "Index '{index_name}' is dropped, but {pending}{} node(s) still held a copy after {MAX_DROP_ACKNOWLEDGE_WAIT_MS} ms, so a create under that name can fail until they finish",
                        holders.len()
                    ),
                )
                .with_detail("indexName", Value::from(index_name))
                .with_detail(
                    "pendingNodeIds",
                    Value::Array(holders.into_iter().map(Value::String).collect()),
                )
                .with_detail("allocationPending", Value::Bool(table_remains)));
            }
            tokio::time::sleep(Duration::from_millis(DROP_ACKNOWLEDGE_POLL_INTERVAL_MS)).await;
        }
    }

    async fn forget_index(&self, index_name: &str) -> ClusterResult<()> {
        match &self.inner.data {
            Some(data) => data.forget_index(index_name).await,
            None => Ok(()),
        }
    }

    /// Removes an index from the whole cluster: its metadata, its schema, its synonym set, and every node's copy,
    /// and returns once no data node holds a copy and the controller has torn down its allocation. The documents
    /// do not come back.
    ///
    /// The node first drops every index that builds its query suggestions from this one. Where the index is
    /// changing its partition count, the node aborts the change and drops the hidden layout as well.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` for a name that starts with `narsil-generation-` and where the index changed while
    /// it was dropped, with `CONTROLLER_METADATA_INVALID` for a name that the cluster cannot store, with
    /// `INDEX_NOT_FOUND` where neither the cluster nor this node holds the index, with `QUERY_NODE_TIMEOUT` where a
    /// node still holds a copy, or the allocation table remains, 30,000 ms later, and with `NODE_NOT_JOINED` after
    /// shutdown.
    pub async fn drop_index(&self, index_name: &str) -> ClusterResult<()> {
        refuse_hidden_generation(index_name)?;
        self.guard_shutdown()?;
        self.drop_marked_indexes(index_name).await?;
        let dropped = self.drop_served_index(index_name).await?;
        self.forget_index(index_name).await?;
        if let Some(dropped) = dropped {
            self.await_drop_acknowledgement(index_name, dropped.index_uuid.as_deref())
                .await?;
        }
        self.forget_suggestions_of(index_name).await
    }
}
