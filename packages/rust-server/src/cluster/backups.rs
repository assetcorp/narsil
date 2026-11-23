use std::sync::Arc;

use narsil::{Map, Value};
use narsil_cluster::node::{
    BackupListing, BackupProgress, BackupProgressHandler, ClusterNode, CreateBackupOptions,
    RestoreBackupOptions, read_restore_placement, validate_backup_name,
};

use super::served_error;
use crate::errors::{Outcome, ServerError};
use crate::handlers::common::json_object_body;
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::maintenance::accepted;
use crate::state::ServerState;
use crate::tasks::{TaskContext, TaskFailure, TaskLaunch, TaskOperation};

fn failed(error: narsil_cluster::error::ClusterError) -> TaskFailure {
    TaskFailure::Coded(served_error(error))
}

fn steps_of(context: TaskContext) -> BackupProgressHandler {
    Arc::new(move |progress: BackupProgress| {
        let mut steps = Map::with_capacity(2);
        steps.insert("done", Value::Number(progress.done as f64));
        steps.insert("total", Value::Number(progress.total as f64));
        context.report_steps(steps);
    })
}

fn refused(message: &str, key: &str, name: &str) -> ServerError {
    ServerError::invalid(message).with_detail(key, Value::String(name.to_string()))
}

fn named_backup(name: &str) -> Outcome<String> {
    validate_backup_name(name).map_err(served_error)
}

fn object_fields(context: &RouteContext) -> Outcome<Map> {
    match json_object_body(context)? {
        Value::Object(fields) => Ok(fields),
        _ => Err(ServerError::internal()),
    }
}

fn launch(task_type: &'static str, index_name: &str, backup_name: &str) -> TaskLaunch {
    TaskLaunch {
        backup_name: Some(backup_name.to_string()),
        ..TaskLaunch::on(task_type, index_name)
    }
}

async fn create(
    state: &ServerState,
    node: Arc<ClusterNode>,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let index = context.param(0).to_string();
    let body = object_fields(context)?;
    let Some(Value::String(backup)) = body.get("backup") else {
        return Err(refused(
            "The body must carry the backup name as a string in \"backup\"",
            "indexName",
            &index,
        ));
    };
    let query_history = match body.get("queryHistory") {
        None => false,
        Some(Value::Bool(requested)) => *requested,
        Some(_) => {
            return Err(refused(
                "The body accepts only true or false in \"queryHistory\"",
                "indexName",
                &index,
            ));
        }
    };
    let backup = named_backup(backup)?;
    let (named, taken) = (index.clone(), backup.clone());
    let operation: TaskOperation = Box::new(move |task| {
        Box::pin(async move {
            let options = CreateBackupOptions {
                query_history,
                on_progress: Some(steps_of(task)),
            };
            node.create_backup(&named, &taken, &options)
                .await
                .map(drop)
                .map_err(failed)
        })
    });
    accepted(state, launch("backup", &index, &backup), operation).await
}

fn listing_value(listing: BackupListing) -> Value {
    let mut entry = Map::with_capacity(8);
    match listing {
        BackupListing::Summary(summary) => {
            entry.insert("name", Value::String(summary.name));
            entry.insert("indexName", Value::String(summary.index_name));
            entry.insert("startedAt", Value::Number(summary.started_at));
            entry.insert("completedAt", Value::Number(summary.completed_at));
            entry.insert(
                "partitionCount",
                Value::Number(summary.partition_count as f64),
            );
            entry.insert(
                "replicationFactor",
                Value::Number(summary.replication_factor),
            );
            entry.insert("files", Value::Number(summary.files as f64));
            entry.insert("bytes", Value::Number(summary.bytes as f64));
        }
        BackupListing::Damaged(damaged) => {
            let mut error = Map::with_capacity(2);
            error.insert("code", Value::String(damaged.code));
            error.insert("message", Value::String(damaged.message));
            entry.insert("name", Value::String(damaged.name));
            entry.insert("error", Value::Object(error));
        }
    }
    Value::Object(entry)
}

async fn list(node: &ClusterNode) -> Outcome<HttpResponse> {
    let listings = node.list_backups().await.map_err(served_error)?;
    let mut body = Map::with_capacity(1);
    body.insert(
        "backups",
        Value::Array(listings.into_iter().map(listing_value).collect()),
    );
    Ok(json(200, &Value::Object(body)))
}

async fn restore(
    state: &ServerState,
    node: Arc<ClusterNode>,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let backup = named_backup(context.param(0))?;
    let fields = object_fields(context)?;
    let Some(Value::String(index)) = fields.get("indexName") else {
        return Err(refused(
            "The body must carry the new index name as a string in \"indexName\"",
            "backupName",
            &backup,
        ));
    };
    let placement = read_restore_placement(&fields)
        .map_err(|reason| refused(&reason, "backupName", &backup))?;
    let index = index.clone();
    let (named, taken) = (index.clone(), backup.clone());
    let operation: TaskOperation = Box::new(move |task| {
        Box::pin(async move {
            let options = RestoreBackupOptions {
                index_name: named,
                replication_factor: placement.replication_factor,
                constraints: placement.constraints,
                on_progress: Some(steps_of(task)),
            };
            node.restore_backup(&taken, &options)
                .await
                .map(drop)
                .map_err(failed)
        })
    });
    accepted(state, launch("backupRestore", &index, &backup), operation).await
}

async fn delete(
    state: &ServerState,
    node: Arc<ClusterNode>,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let backup = named_backup(context.param(0))?;
    let taken = backup.clone();
    let operation: TaskOperation = Box::new(move |task| {
        Box::pin(async move {
            let on_progress = steps_of(task);
            node.delete_backup(&taken, Some(&on_progress))
                .await
                .map_err(failed)
        })
    });
    accepted(state, launch("backupDelete", "", &backup), operation).await
}

pub(super) async fn handle(
    state: &ServerState,
    node: Arc<ClusterNode>,
    route: Route,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::CreateBackup => create(state, node, context).await,
        Route::ListBackups => list(&node).await,
        Route::RestoreBackup => restore(state, node, context).await,
        Route::DeleteBackup => delete(state, node, context).await,
        _ => Err(ServerError::internal()),
    }
}
