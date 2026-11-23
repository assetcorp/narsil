use narsil::{Map, Value};
use narsil_cluster::node::{ClusterIndexStats, ClusterNode, ClusterPartitionStats};

use super::served_error;
use super::writes::refuse_wait;
use crate::documents::answers::{documents_answer, index_info, ordered_documents};
use crate::documents::bodies::{document_of, multi_get_ids, multi_get_projection, read_projection};
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::{json_object_body, object};
use crate::handlers::documents::not_found;
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::state::ServerState;

fn count(value: u64) -> Value {
    Value::Number(value as f64)
}

fn insert_figure(entry: &mut Map, key: &str, figure: Option<u64>) {
    if let Some(figure) = figure {
        entry.insert(key, count(figure));
    }
}

fn index_stats(stats: ClusterIndexStats) -> Value {
    let mut entry = Map::with_capacity(9);
    entry.insert("documentCount", count(stats.document_count));
    entry.insert("partitionCount", count(stats.partition_count as u64));
    entry.insert("estimatedMemoryBytes", count(stats.estimated_memory_bytes));
    insert_figure(&mut entry, "savedBytes", stats.saved_bytes);
    insert_figure(&mut entry, "logBytes", stats.log_bytes);
    insert_figure(
        &mut entry,
        "savedBytesOfEveryCopy",
        stats.saved_bytes_of_every_copy,
    );
    insert_figure(
        &mut entry,
        "logBytesOfEveryCopy",
        stats.log_bytes_of_every_copy,
    );
    entry.insert("language", Value::String(stats.language));
    entry.insert("schema", stats.schema);
    Value::Object(entry)
}

fn partition_stats(partitions: Vec<ClusterPartitionStats>) -> Value {
    let listed = partitions
        .into_iter()
        .map(|partition| {
            let mut entry = Map::with_capacity(7);
            entry.insert("partitionId", count(u64::from(partition.partition_id)));
            entry.insert("documentCount", count(partition.document_count));
            entry.insert(
                "estimatedMemoryBytes",
                count(partition.estimated_memory_bytes),
            );
            insert_figure(&mut entry, "savedBytes", partition.saved_bytes);
            insert_figure(&mut entry, "logBytes", partition.log_bytes);
            insert_figure(
                &mut entry,
                "savedBytesOfEveryCopy",
                partition.saved_bytes_of_every_copy,
            );
            insert_figure(
                &mut entry,
                "logBytesOfEveryCopy",
                partition.log_bytes_of_every_copy,
            );
            Value::Object(entry)
        })
        .collect();
    object(vec![("partitions", Value::Array(listed))])
}

async fn get(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let projection = read_projection(context.query_value("vectors"))?;
    let id = context.param(1);
    let found = node
        .get_with(context.param(0), id, projection.as_ref())
        .await
        .map_err(served_error)?;
    let document = found.ok_or_else(|| not_found(id))?;
    Ok(json(
        200,
        &object(vec![("document", Value::Object(document))]),
    ))
}

async fn multi_get(
    state: &ServerState,
    node: &ClusterNode,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let body = json_object_body(context)?;
    let wanted = multi_get_ids(&body, state.limits.max_fetch_documents)?;
    let projection = multi_get_projection(&body)?;
    let found = node
        .get_multiple_with(context.param(0), &wanted, projection.as_ref())
        .await
        .map_err(served_error)?;
    Ok(documents_answer(ordered_documents(&wanted, found)))
}

async fn put(node: &ClusterNode, context: &RouteContext) -> Outcome<HttpResponse> {
    let mut body = json_object_body(context)?;
    let document = document_of(&mut body)?;
    refuse_wait(&body)?;
    let (index, id) = (context.param(0), context.param(1));
    let created = !node.has(index, id).await.map_err(served_error)?;
    let id = if created {
        node.insert(index, document, Some(id))
            .await
            .map_err(served_error)?
    } else {
        node.update(index, id, document)
            .await
            .map_err(served_error)?;
        id.to_string()
    };
    let answer = object(vec![
        ("id", Value::String(id)),
        ("created", Value::Bool(created)),
    ]);
    Ok(json(if created { 201 } else { 200 }, &answer))
}

async fn index_reads(node: &ClusterNode, route: Route, index: &str) -> Outcome<Value> {
    Ok(match route {
        Route::Count => object(vec![(
            "count",
            count(node.count_documents(index).await.map_err(served_error)?),
        )]),
        Route::IndexStats => index_stats(node.get_stats(index).await.map_err(served_error)?),
        Route::IndexPartitions => partition_stats(
            node.get_partition_stats(index)
                .await
                .map_err(served_error)?,
        ),
        _ => return Err(ServerError::internal()),
    })
}

pub(super) async fn handle(
    state: &ServerState,
    node: &ClusterNode,
    route: Route,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::Get => get(node, context).await,
        Route::MultiGet => multi_get(state, node, context).await,
        Route::Put => put(node, context).await,
        Route::Exists => {
            let exists = node
                .has(context.param(0), context.param(1))
                .await
                .map_err(served_error)?;
            Ok(json(200, &object(vec![("exists", Value::Bool(exists))])))
        }
        Route::ListIndexes => {
            let indexes = node.list_indexes().await.map_err(served_error)?;
            let listed = Value::Array(indexes.iter().map(index_info).collect());
            Ok(json(200, &object(vec![("indexes", listed)])))
        }
        Route::Count | Route::IndexStats | Route::IndexPartitions => Ok(json(
            200,
            &index_reads(node, route, context.param(0)).await?,
        )),
        _ => Err(ServerError::internal()),
    }
}
