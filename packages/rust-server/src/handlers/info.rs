use narsil::{Map, Value};

use crate::errors::Outcome;
use crate::http::respond::{HttpResponse, json};
use crate::state::ServerState;

pub(crate) const SERVER_CAPABILITIES: [&str; 9] = [
    "documents.import.async",
    "tasks.cancel",
    "tasks.filter",
    "indexes.rebuildAnalysis",
    "indexes.changeAnalysis",
    "indexes.lifecycle",
    "indexes.documentExport",
    "indexes.synonyms",
    "indexes.bm25",
];

const VECTOR_SEARCH_PATH: &str = "native";

fn status_body(status: &str) -> Value {
    let mut body = Map::new();
    body.insert("status", Value::String(status.to_string()));
    Value::Object(body)
}

pub(crate) fn livez() -> Outcome<HttpResponse> {
    Ok(json(200, &status_body("ok")))
}

pub(crate) fn readyz(state: &ServerState) -> Outcome<HttpResponse> {
    if state.is_ready() {
        Ok(json(200, &status_body("ready")))
    } else {
        Ok(json(503, &status_body("unavailable")))
    }
}

pub(crate) fn version(state: &ServerState) -> Outcome<HttpResponse> {
    let build = &state.build;
    let mut body = Map::new();
    body.insert("name", Value::String("narsil".to_string()));
    body.insert("version", Value::String(build.version.clone()));
    body.insert(
        "gitSha",
        build.git_sha.clone().map_or(Value::Null, Value::String),
    );
    body.insert("dirty", Value::Bool(build.dirty));
    body.insert(
        "vectorSearch",
        Value::String(VECTOR_SEARCH_PATH.to_string()),
    );
    Ok(json(200, &Value::Object(body)))
}

pub(crate) fn capabilities() -> Outcome<HttpResponse> {
    let mut body = Map::new();
    body.insert(
        "capabilities",
        Value::Array(
            SERVER_CAPABILITIES
                .iter()
                .map(|name| Value::String((*name).to_string()))
                .collect(),
        ),
    );
    Ok(json(200, &Value::Object(body)))
}
