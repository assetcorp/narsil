use std::future::Future;
use std::sync::Arc;

use narsil::Map;

use super::ReadDeps;
use super::node_messaging::{
    SendFailureContext, answer_is_refusal, decoded_answer, no_active_replica, read_rejection_of,
    send_to_node,
};
use super::routable_allocation::live_allocation_once;
use crate::allocator::Table;
use crate::error::ClusterResult;
use crate::message::TransportMessage;
use crate::query::failover::{Attempt, Failure, send_to_every_partition};
use crate::query::selection::{RandomSelector, select_replicas_for_query};

#[derive(Debug, Clone)]
pub(crate) struct ScatterGroup {
    pub(crate) node_id: String,
    pub(crate) partition_ids: Vec<u32>,
}

pub(crate) async fn gather_from_every_partition<T, F, Fut>(
    deps: &ReadDeps,
    table: &Table,
    index_name: &str,
    read: F,
    read_live: bool,
) -> Result<Vec<T>, Failure>
where
    T: Send + 'static,
    F: Fn(ScatterGroup) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<T, Failure>> + Send + 'static,
{
    let mut routing = select_replicas_for_query(table, &RandomSelector);
    if read_live
        && !routing.unavailable_partitions.is_empty()
        && let Some(live) = live_allocation_once(deps, index_name).await
    {
        routing = select_replicas_for_query(&live, &RandomSelector);
    }
    if !routing.unavailable_partitions.is_empty() {
        return Err(Failure::of(no_active_replica(
            index_name,
            &routing.unavailable_partitions,
        )));
    }
    let read = Arc::new(read);
    let attempt: Attempt<T> = Arc::new(move |node_id, partition_ids| {
        let answer = read(ScatterGroup {
            node_id,
            partition_ids,
        });
        Box::pin(async move { answer.await.map(Some) })
    });
    send_to_every_partition(&routing, attempt).await
}

pub(crate) async fn send_read_request<T>(
    deps: &ReadDeps,
    target_node_id: &str,
    message: &TransportMessage,
    index_name: &str,
    validate: impl FnOnce(Map) -> ClusterResult<T>,
) -> Result<T, Failure> {
    let answer = send_to_node(
        deps,
        target_node_id,
        message,
        &SendFailureContext {
            message: format!(
                "Node '{target_node_id}' did not answer a read request for index '{index_name}'"
            ),
            index_name: Some(index_name.to_string()),
        },
    )
    .await?;
    let decoded = decoded_answer(&answer)?;
    if answer_is_refusal(&answer, &decoded) {
        return Err(read_rejection_of(&decoded, target_node_id, index_name));
    }
    Ok(validate(decoded)?)
}
