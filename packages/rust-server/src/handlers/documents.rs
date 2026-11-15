use std::sync::Arc;

use narsil::{ErrorCode, Map, Narsil, Value};

use super::common::{engine_call, json_body, object};
use crate::documents::answers::{documents_answer, ordered_documents};
use crate::documents::batch::{batch_request, run_batch};
use crate::documents::bodies::{ChosenId, document_of, insert_id_of, multi_get_ids};
use crate::errors::{Outcome, ServerError};
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::state::ServerState;

fn text(value: &str) -> Value {
    Value::String(value.to_string())
}

fn refused_insert(
    engine: &Narsil,
    index: &str,
    refusal: ServerError,
) -> narsil::Result<Result<String, ServerError>> {
    engine.wait_for_writes(index)?;
    Ok(Err(refusal))
}

async fn insert(state: &Arc<ServerState>, context: &RouteContext) -> Outcome<HttpResponse> {
    let mut body = json_body(context)?;
    let document = document_of(&mut body)?;
    let index = context.param(0).to_string();
    let chosen = insert_id_of(&body, &document);
    let inserted = engine_call(state, move |engine| match chosen {
        ChosenId::Refused(refusal) => refused_insert(engine, &index, refusal),
        ChosenId::Given(id) => engine.insert(&index, document, Some(&id)).map(Ok),
        ChosenId::Absent => engine.insert(&index, document, None).map(Ok),
    })
    .await??;
    Ok(json(201, &object(vec![("id", Value::String(inserted))])))
}

async fn put(state: &Arc<ServerState>, context: &RouteContext) -> Outcome<HttpResponse> {
    let mut body = json_body(context)?;
    let document = document_of(&mut body)?;
    let index = context.param(0).to_string();
    let id = context.param(1).to_string();
    let (id, created) = engine_call(state, move |engine| {
        if engine.has(&index, &id)? {
            engine.update(&index, &id, document)?;
            Ok((id, false))
        } else {
            Ok((engine.insert(&index, document, Some(&id))?, true))
        }
    })
    .await?;
    let answer = object(vec![
        ("id", Value::String(id)),
        ("created", Value::Bool(created)),
    ]);
    Ok(json(if created { 201 } else { 200 }, &answer))
}

async fn patch(state: &Arc<ServerState>, context: &RouteContext) -> Outcome<HttpResponse> {
    let mut body = json_body(context)?;
    let document = document_of(&mut body)?;
    let index = context.param(0).to_string();
    let id = context.param(1).to_string();
    let updated = id.clone();
    engine_call(state, move |engine| {
        engine.update(&index, &updated, document)
    })
    .await?;
    Ok(json(200, &object(vec![("id", Value::String(id))])))
}

async fn batch(state: &Arc<ServerState>, context: &RouteContext) -> Outcome<HttpResponse> {
    let request = batch_request(json_body(context)?)?;
    let index = context.param(0).to_string();
    let written = engine_call(state, move |engine| run_batch(engine, &index, request)).await?;
    Ok(json(200, &written.to_value()))
}

async fn multi_get(state: &Arc<ServerState>, context: &RouteContext) -> Outcome<HttpResponse> {
    let body = json_body(context)?;
    let wanted = multi_get_ids(&body, state.limits.max_fetch_documents)?;
    let index = context.param(0).to_string();
    let documents = engine_call(state, move |engine| {
        let found = engine.get_multiple(&index, &wanted)?;
        Ok(ordered_documents(&wanted, found))
    })
    .await?;
    Ok(documents_answer(documents))
}

fn not_found(doc_id: &str) -> ServerError {
    let mut details = Map::new();
    details.insert("docId", text(doc_id));
    ServerError::coded(
        ErrorCode::DOC_NOT_FOUND.as_str(),
        format!("Document \"{doc_id}\" not found"),
    )
    .with_details(details)
}

async fn read(
    state: &Arc<ServerState>,
    route: Route,
    context: &RouteContext,
) -> Outcome<HttpResponse> {
    let index = context.param(0).to_string();
    let id = context.param(1).to_string();
    let answer = engine_call(state, move |engine| {
        Ok(match route {
            Route::Get => engine
                .get(&index, &id)?
                .map(|document| object(vec![("document", Value::Object(document))]))
                .ok_or_else(|| not_found(&id)),
            Route::Exists => Ok(object(vec![(
                "exists",
                Value::Bool(engine.has(&index, &id)?),
            )])),
            Route::Remove => {
                engine.remove(&index, &id)?;
                Ok(object(vec![
                    ("id", text(&id)),
                    ("removed", Value::Bool(true)),
                ]))
            }
            _ => {
                engine.wait_for_writes(&index)?;
                Ok(object(vec![("ok", Value::Bool(true))]))
            }
        })
    })
    .await??;
    Ok(json(200, &answer))
}

pub(crate) async fn handle(
    state: Arc<ServerState>,
    route: Route,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::Insert => insert(&state, &context).await,
        Route::Put => put(&state, &context).await,
        Route::Patch => patch(&state, &context).await,
        Route::Batch => batch(&state, &context).await,
        Route::MultiGet => multi_get(&state, &context).await,
        Route::Get | Route::Exists | Route::Remove | Route::WaitForWrites => {
            read(&state, route, &context).await
        }
        _ => Err(ServerError::internal()),
    }
}
