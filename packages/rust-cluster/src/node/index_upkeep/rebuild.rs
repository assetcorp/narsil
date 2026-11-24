use std::sync::Arc;

use narsil::{Map, Value};
use tokio::task::JoinSet;

use crate::allocator::Table;
use crate::controller::index_metadata;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{ERROR_TYPE_SUFFIX, TransportMessage, message_types};
use crate::node::handle::ClusterNode;
use crate::query::version_routing::copy_holders_of;
use crate::reads::node_messaging::{SendFailureContext, decoded_answer, request, send_to_node};
use crate::reads::{ReadDeps, serving_name};

fn holder_error(code: &str, message: String, index_name: &str, holder: &str) -> ClusterError {
    ClusterError::new(code, message)
        .with_detail("indexName", Value::from(index_name))
        .with_detail("nodeId", Value::from(holder))
}

fn answered_rebuild(decoded: &Map, index_name: &str) -> bool {
    decoded.get("indexName").and_then(Value::as_str) == Some(index_name)
        && matches!(decoded.get("rebuiltPartitions"), Some(Value::Array(_)))
}

async fn still_registered(deps: &ReadDeps, holder: &str) -> ClusterResult<bool> {
    Ok(deps
        .coordinator
        .list_nodes()
        .await?
        .iter()
        .any(|node| node.node_id == holder))
}

async fn rebuild_on(
    deps: Arc<ReadDeps>,
    holder: String,
    message: TransportMessage,
    index_name: String,
) -> ClusterResult<()> {
    let failure = SendFailureContext {
        message: format!("Node '{holder}' did not answer the rebuild of index '{index_name}'"),
        index_name: Some(index_name.clone()),
    };
    loop {
        if !still_registered(&deps, &holder).await? {
            return Err(holder_error(
                codes::QUERY_ROUTING_FAILED,
                format!("Node '{holder}' left the cluster before it rebuilt index '{index_name}'"),
                &index_name,
                &holder,
            ));
        }
        let outcome = match send_to_node(&deps, &holder, &message, &failure).await {
            Ok(answer) => answer_of(&answer, &index_name, &holder),
            Err(error) => Err(error),
        };
        match outcome {
            Err(error) if error.code() == codes::QUERY_NODE_TIMEOUT => continue,
            other => return other,
        }
    }
}

fn answer_of(answer: &TransportMessage, index_name: &str, holder: &str) -> ClusterResult<()> {
    let decoded = decoded_answer(answer)?;
    if answer.message_type.ends_with(ERROR_TYPE_SUFFIX) {
        let code = decoded
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or(codes::QUERY_ROUTING_FAILED);
        return Err(holder_error(
            code,
            format!("Node '{holder}' failed the rebuild of index '{index_name}'"),
            index_name,
            holder,
        ));
    }
    if !answered_rebuild(&decoded, index_name) {
        return Err(ClusterError::new(
            codes::QUERY_ROUTING_FAILED,
            format!("A node answered a rebuild of index '{index_name}' with a malformed payload"),
        )
        .with_detail("indexName", Value::from(index_name)));
    }
    Ok(())
}

fn no_metadata(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::INDEX_NOT_FOUND,
        format!("Index '{index_name}' has no metadata in the cluster"),
    )
    .with_detail("indexName", Value::from(index_name))
}

impl ClusterNode {
    async fn rebuild_serving(&self, deps: &Arc<ReadDeps>, serving: &str) -> ClusterResult<()> {
        let coordinator = self.inner.coordinator();
        let metadata = index_metadata(coordinator, serving).await?;
        let table = coordinator.allocation(serving).await?;
        let (Some(metadata), Some(table)) = (metadata, table) else {
            return Err(no_metadata(serving));
        };
        let mut payload = Map::with_capacity(2);
        payload.insert("indexName", Value::from(serving));
        payload.insert("indexUuid", Value::from(metadata.index_uuid.as_str()));
        let message = request(deps, message_types::CLUSTER_REBUILD_ANALYSIS, &payload)?;
        let holders = copy_holders_of(&Table::from_stored(&table));
        let mut remote = JoinSet::new();
        let mut failed = Vec::new();
        for holder in &holders {
            if holder == self.node_id() {
                let rebuilt = match &self.inner.data {
                    Some(data) => {
                        data.rebuild_local_analysis(serving, &metadata.index_uuid)
                            .await
                    }
                    None => Ok(()),
                };
                if rebuilt.is_err() {
                    failed.push(holder.clone());
                }
                continue;
            }
            let attempt = rebuild_on(
                Arc::clone(deps),
                holder.clone(),
                message.clone(),
                serving.to_string(),
            );
            let holder = holder.clone();
            remote.spawn(async move { (holder, attempt.await.is_ok()) });
        }
        while let Some(joined) = remote.join_next().await {
            match joined {
                Ok((_, true)) => {}
                Ok((holder, false)) => failed.push(holder),
                Err(_) => {}
            }
        }
        if failed.is_empty() {
            return Ok(());
        }
        failed.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        Err(ClusterError::new(
            codes::QUERY_PARTIAL_FAILURE,
            format!(
                "The rebuild of index '{serving}' failed on {} node(s): {}",
                failed.len(),
                failed.join(", ")
            ),
        )
        .with_detail("indexName", Value::from(serving))
        .with_detail(
            "nodeIds",
            Value::Array(failed.into_iter().map(Value::String).collect()),
        ))
    }

    /// Rebuilds the terms of every copy of a cluster index whose analysis is stale, asking each node that holds a
    /// copy in turn until it answers or leaves the cluster.
    ///
    /// # Errors
    ///
    /// Fails with `NODE_NOT_JOINED` before the node joins or once it shuts down, with `INDEX_ORPHANED` where this
    /// node keeps an orphaned copy under that name, with `CONFIG_INVALID` for a name that starts with
    /// `narsil-generation-`, with `INDEX_NOT_FOUND` where the cluster holds no metadata or allocation table for
    /// the index, and with `QUERY_PARTIAL_FAILURE`, which lists the nodes whose rebuild failed.
    pub async fn rebuild_analysis(&self, index_name: &str) -> ClusterResult<()> {
        let reads = self.inner.reads()?;
        self.track(Some(index_name), async {
            let serving = serving_name(&reads, index_name).await?;
            self.rebuild_serving(&reads, &serving).await
        })
        .await
    }
}
