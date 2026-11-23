use std::collections::BTreeSet;
use std::sync::Arc;

use narsil::{Map, Value, decode_msgpack};
use tokio::task::JoinSet;

use crate::allocator::Table;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{CARRIER_ERROR_TYPE, ERROR_TYPE_SUFFIX, TransportMessage, message_types};
use crate::node::handle::ClusterNode;
use crate::reads::ReadDeps;
use crate::reads::node_messaging::request;

fn applied_answer(decoded: &Value) -> bool {
    let Value::Object(fields) = decoded else {
        return false;
    };
    matches!(fields.get("indexName"), Some(Value::String(_)))
        && matches!(fields.get("applied"), Some(Value::Bool(_)))
}

fn refused(decoded: &Value, holder: &str, index_name: &str) -> ClusterError {
    let text = |key: &str| match decoded {
        Value::Object(fields) => fields.get(key).and_then(Value::as_str),
        _ => None,
    };
    let message = text("message").map(str::to_string).unwrap_or_else(|| {
        format!("Node '{holder}' did not apply the synonym set of index '{index_name}'")
    });
    ClusterError::new(text("code").unwrap_or(codes::QUERY_ROUTING_FAILED), message)
        .with_detail("indexName", Value::from(index_name))
        .with_detail("targetNodeId", Value::from(holder))
}

async fn ask_holder(
    deps: Arc<ReadDeps>,
    holder: String,
    message: TransportMessage,
    index_name: String,
) -> ClusterResult<()> {
    let mut transport_code = None;
    for target in deps.view.targets(&holder) {
        let answer = match deps.transport.send(&target, message.clone()).await {
            Ok(answer) if answer.message_type == CARRIER_ERROR_TYPE => {
                transport_code = answer.failure().map(|failure| failure.code().to_string());
                continue;
            }
            Ok(answer) => answer,
            Err(error) => {
                transport_code = Some(error.code().to_string());
                continue;
            }
        };
        let decoded = decode_msgpack(&answer.payload).map_err(ClusterError::from)?;
        if !answer.message_type.ends_with(ERROR_TYPE_SUFFIX) && applied_answer(&decoded) {
            return Ok(());
        }
        return Err(refused(&decoded, &holder, &index_name));
    }
    let mut error = ClusterError::new(
        codes::QUERY_NODE_TIMEOUT,
        format!(
            "Node '{holder}' did not answer when asked to apply the new synonym set of index '{index_name}'. The set stays stored, so retry the request to finish applying it"
        ),
    )
    .with_detail("indexName", Value::from(index_name.as_str()))
    .with_detail("targetNodeId", Value::from(holder.as_str()));
    if let Some(code) = transport_code {
        error = error.with_detail("transportCode", Value::from(code));
    }
    Err(error)
}

fn holders_of(table: Option<Table>) -> BTreeSet<String> {
    let mut holders = BTreeSet::new();
    for assignment in table.iter().flat_map(|table| table.assignments.values()) {
        holders.extend(assignment.replicas.iter().cloned());
        holders.extend(assignment.primary.iter().cloned());
    }
    holders
}

impl ClusterNode {
    pub(super) async fn apply_synonyms_on_holders(
        &self,
        deps: &Arc<ReadDeps>,
        serving: &str,
        index_uuid: &str,
    ) -> ClusterResult<()> {
        let stored = self.inner.coordinator().allocation(serving).await?;
        let holders = holders_of(stored.map(|table| Table::from_stored(&table)));
        let mut payload = Map::with_capacity(2);
        payload.insert("indexName", Value::from(serving));
        payload.insert("indexUuid", Value::from(index_uuid));
        let message = request(deps, message_types::CLUSTER_INDEX_SETTINGS, &payload)?;
        let mut asked = JoinSet::new();
        let mut first_failure = None;
        for holder in holders {
            if holder == self.node_id() {
                if let Some(data) = &self.inner.data
                    && let Err(error) = data.apply_index_settings(serving, index_uuid).await
                {
                    first_failure.get_or_insert(error);
                }
                continue;
            }
            asked.spawn(ask_holder(
                Arc::clone(deps),
                holder,
                message.clone(),
                serving.to_string(),
            ));
        }
        while let Some(joined) = asked.join_next().await {
            if let Ok(Err(error)) = joined {
                first_failure.get_or_insert(error);
            }
        }
        match first_failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
