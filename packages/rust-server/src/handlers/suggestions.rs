use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures_util::FutureExt;
use narsil::{
    ErrorCode, ManualQuerySuggestion, Map, QuerySuggestionsSetting, RecordQueryOutcome,
    RecordQueryResult, RecordedQuery, Value,
};

use super::common::{engine_call, json_body, object};
use crate::errors::{Outcome, ServerError, server_codes};
use crate::http::pipeline::RouteContext;
use crate::http::respond::{HttpResponse, json};
use crate::http::routes::Route;
use crate::options::QueryIdentity;
use crate::search::{
    MAX_PREVIEW_LIMIT_DIGITS, bans_value, not_an_object, preview_value, recorded_value,
    status_value,
};
use crate::state::ServerState;

fn body_object(context: &RouteContext) -> Outcome<Map> {
    match json_body(context)? {
        Value::Object(body) => Ok(body),
        _ => Err(not_an_object()),
    }
}

fn phrase_of(body: &Map) -> Outcome<String> {
    match body.get("query") {
        Some(Value::String(query)) => Ok(query.clone()),
        _ => Err(ServerError::invalid(
            "The body must carry the phrase as a string in \"query\"",
        )),
    }
}

fn ok() -> HttpResponse {
    json(200, &object(vec![("ok", Value::Bool(true))]))
}

async fn update(state: Arc<ServerState>, context: RouteContext) -> Outcome<HttpResponse> {
    let body = json_body(&context)?;
    let setting = QuerySuggestionsSetting::from_input(&body)?;
    let index = context.param(0).to_string();
    engine_call(&state, move |engine| {
        engine.query_suggestions().update_setting(&index, &setting)
    })
    .await?;
    Ok(ok())
}

async fn status(state: Arc<ServerState>, context: RouteContext) -> Outcome<HttpResponse> {
    let index = context.param(0).to_string();
    let status = engine_call(&state, move |engine| {
        engine.query_suggestions().status(&index)
    })
    .await?;
    Ok(json(200, &status_value(status)))
}

fn no_identify(index: &str) -> ServerError {
    ServerError::coded(
        ErrorCode::QUERY_SUGGESTIONS_NOT_ENABLED.as_str(),
        "This server has no identify function for popular query suggestions, so it counts no search",
    )
    .with_detail("indexName", Value::String(index.to_string()))
}

fn identify_failure() -> ServerError {
    ServerError::new(
        500,
        server_codes::HOOK_ERROR,
        "The identify function of query suggestions failed",
    )
}

fn unidentified() -> HttpResponse {
    json(
        200,
        &recorded_value(RecordQueryResult {
            recorded: false,
            outcome: RecordQueryOutcome::Unidentified,
        }),
    )
}

async fn record(state: Arc<ServerState>, context: RouteContext) -> Outcome<HttpResponse> {
    let body = body_object(&context)?;
    let extra: Vec<Value> = body
        .keys()
        .filter(|key| key.as_str() != "query")
        .map(|key| Value::String(key.clone()))
        .collect();
    if !extra.is_empty() {
        return Err(ServerError::invalid(
            "The body carries the search in \"query\" alone, because the server identifies the person",
        )
        .with_detail("fields", Value::Array(extra)));
    }
    let query = phrase_of(&body)?;
    let index = context.param(0).to_string();
    let Some(identify) = state.identify.clone() else {
        return Err(no_identify(&index));
    };
    let Some(request) = context.hook_context else {
        return Err(identify_failure());
    };
    let identity = AssertUnwindSafe(identify.identify(request))
        .catch_unwind()
        .await;
    let (person, group) = match identity {
        Ok(Ok(None)) => return Ok(unidentified()),
        Ok(Ok(Some(QueryIdentity {
            person: Some(person),
            group: Some(group),
        }))) => (person, group),
        _ => return Err(identify_failure()),
    };
    let recorded = RecordedQuery {
        query,
        person,
        group,
    };
    let result = engine_call(&state, move |engine| {
        engine.query_suggestions().record_query(&index, &recorded)
    })
    .await?;
    Ok(json(200, &recorded_value(result)))
}

fn preview_limit(context: &RouteContext) -> Outcome<Option<u32>> {
    let Some(raw) = context.query_value("limit") else {
        return Ok(None);
    };
    let digits = !raw.is_empty()
        && raw.len() <= MAX_PREVIEW_LIMIT_DIGITS
        && raw.bytes().all(|byte| byte.is_ascii_digit());
    match raw.parse::<u32>() {
        Ok(limit) if digits => Ok(Some(limit)),
        _ => Err(
            ServerError::invalid("Query parameter \"limit\" must be a whole number")
                .with_detail("value", Value::String(raw.to_string())),
        ),
    }
}

async fn preview(state: Arc<ServerState>, context: RouteContext) -> Outcome<HttpResponse> {
    let limit = preview_limit(&context)?;
    let index = context.param(0).to_string();
    let preview = engine_call(&state, move |engine| {
        engine.query_suggestions().preview(&index, limit)
    })
    .await?;
    Ok(json(200, &preview_value(preview)))
}

async fn read_bans(state: Arc<ServerState>, context: RouteContext) -> Outcome<HttpResponse> {
    let index = context.param(0).to_string();
    let bans = engine_call(&state, move |engine| {
        engine.query_suggestions().bans(&index)
    })
    .await?;
    Ok(json(200, &bans_value(bans)))
}

fn ban_list(body: &Map) -> Outcome<Vec<String>> {
    let refusal = || {
        ServerError::invalid("The body must carry the ban list as an array of strings in \"bans\"")
    };
    let Some(Value::Array(items)) = body.get("bans") else {
        return Err(refusal());
    };
    items
        .iter()
        .map(|item| item.as_str().map(str::to_string).ok_or_else(refusal))
        .collect()
}

async fn replace_bans(state: Arc<ServerState>, context: RouteContext) -> Outcome<HttpResponse> {
    let phrases = ban_list(&body_object(&context)?)?;
    let index = context.param(0).to_string();
    let bans = engine_call(&state, move |engine| {
        engine.query_suggestions().update_bans(&index, &phrases)
    })
    .await?;
    Ok(json(200, &bans_value(bans)))
}

async fn remove(state: Arc<ServerState>, context: RouteContext) -> Outcome<HttpResponse> {
    let query = phrase_of(&body_object(&context)?)?;
    let index = context.param(0).to_string();
    let held = engine_call(&state, move |engine| {
        engine.query_suggestions().remove_query(&index, &query)
    })
    .await?;
    Ok(json(
        200,
        &object(vec![("suggestionIndexes", Value::Number(held as f64))]),
    ))
}

fn manual_count(count: Option<&Value>) -> Outcome<Option<u64>> {
    match count {
        None => Ok(None),
        Some(Value::Number(count)) => {
            let whole = count.is_finite() && count.fract() == 0.0 && *count >= 0.0;
            Ok(Some(if whole && *count < u64::MAX as f64 {
                *count as u64
            } else {
                u64::MAX
            }))
        }
        Some(_) => Err(manual_refusal()),
    }
}

fn manual_refusal() -> ServerError {
    ServerError::invalid(
        "The body must carry the group as a string in \"group\", and any count as a number in \"count\"",
    )
}

async fn manual(state: Arc<ServerState>, context: RouteContext) -> Outcome<HttpResponse> {
    let body = body_object(&context)?;
    let query = phrase_of(&body)?;
    let group = match body.get("group") {
        Some(Value::String(group)) => group.clone(),
        _ => return Err(manual_refusal()),
    };
    let suggestion = ManualQuerySuggestion {
        group,
        query,
        count: manual_count(body.get("count"))?,
    };
    let index = context.param(0).to_string();
    let name = engine_call(&state, move |engine| {
        engine
            .query_suggestions()
            .add_suggestion(&index, &suggestion)
    })
    .await?;
    Ok(json(200, &object(vec![("indexName", Value::String(name))])))
}

pub(crate) async fn handle(
    state: Arc<ServerState>,
    route: Route,
    context: RouteContext,
) -> Outcome<HttpResponse> {
    match route {
        Route::UpdateQuerySuggestions => update(state, context).await,
        Route::QuerySuggestionsStatus => status(state, context).await,
        Route::RecordQuery => record(state, context).await,
        Route::PreviewQuerySuggestions => preview(state, context).await,
        Route::ReadQueryBans => read_bans(state, context).await,
        Route::ReplaceQueryBans => replace_bans(state, context).await,
        Route::RemoveQuery => remove(state, context).await,
        Route::AddManualSuggestion => manual(state, context).await,
        _ => Err(ServerError::internal()),
    }
}
