use narsil::{Map, Value, validate_index_name};
use narsil_cluster::coordinator::AllocationTable;
use narsil_cluster::node::ClusterNode;

use super::served_error;
use crate::documents::bodies::field;
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::{json_body, object};
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;

const SCALAR_FIELDS: [&str; 4] = ["state", "primary", "primaryTerm", "commitPoint"];
const LIST_FIELDS: [&str; 3] = ["replicas", "inSyncSet", "lastHolders"];

fn named_index(context: &RouteContext) -> Outcome<String> {
    let index = context.param(0).to_string();
    match validate_index_name(&index) {
        Ok(()) => Ok(index),
        Err(error) => {
            Err(ServerError::invalid(error.message())
                .with_detail("indexName", Value::String(index)))
        }
    }
}

fn partition_report(partition_id: f64, assignment: &Map) -> Value {
    let mut report = Map::with_capacity(9);
    report.insert("partitionId", Value::Number(partition_id));
    for key in SCALAR_FIELDS {
        report.insert(key, assignment.get(key).cloned().unwrap_or(Value::Null));
    }
    for key in LIST_FIELDS {
        let list = match assignment.get(key) {
            Some(Value::Array(items)) => Value::Array(items.clone()),
            _ => Value::Array(Vec::new()),
        };
        report.insert(key, list);
    }
    report.insert(
        "unassignedReason",
        assignment
            .get("unassignedReason")
            .cloned()
            .unwrap_or(Value::Null),
    );
    Value::Object(report)
}

fn allocation_answer(index: String, table: Option<AllocationTable>) -> Value {
    let Some(table) = table else {
        return object(vec![
            ("indexName", Value::String(index)),
            ("allocated", Value::Bool(false)),
            ("version", Value::Null),
            ("partitions", Value::Array(Vec::new())),
        ]);
    };
    let mut assignments = table.assignments;
    assignments.sort_by(|left, right| left.0.total_cmp(&right.0));
    let partitions: Vec<Value> = assignments
        .iter()
        .map(|(partition_id, assignment)| partition_report(*partition_id, assignment))
        .collect();
    object(vec![
        ("indexName", Value::String(index)),
        ("allocated", Value::Bool(!partitions.is_empty())),
        ("version", Value::Number(table.version)),
        ("partitions", Value::Array(partitions)),
    ])
}

async fn replication_factor(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let index = named_index(context)?;
    let body = json_body(context)?;
    let Some(Value::Number(factor)) = field(&body, "replicationFactor").cloned() else {
        return Err(
            ServerError::invalid("The body must carry a numeric replicationFactor")
                .with_detail("indexName", Value::String(index)),
        );
    };
    node.set_replication_factor(&index, factor)
        .await
        .map_err(served_error)?;
    let answer = object(vec![
        ("indexName", Value::String(index)),
        ("replicationFactor", Value::Number(factor)),
    ]);
    Ok(json(200, &answer))
}

pub(super) async fn handle(
    node: &ClusterNode,
    route: Route,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::ClusterAllocation => {
            let index = named_index(context)?;
            let table = node.allocation(&index).await.map_err(served_error)?;
            Ok(json(200, &allocation_answer(index, table)))
        }
        Route::ClusterReplicationFactor => replication_factor(node, context).await,
        _ => Err(ServerError::internal()),
    }
}
