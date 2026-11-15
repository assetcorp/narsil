use narsil::{Map, Value};

use super::constants::{DEFAULT_PAGE_SIZE, DEFAULT_RERANK_WINDOW, MAX_SORT_FIELDS};
use super::reader::entries_of;
use crate::errors::{Outcome, ServerError};
use crate::state::ResolvedLimits;

fn detailed(message: String, details: Vec<(&str, Value)>) -> ServerError {
    let mut map = Map::with_capacity(details.len());
    for (key, value) in details {
        map.insert(key, value);
    }
    let mut failure = ServerError::invalid(message);
    failure.details = Some(map);
    failure
}

fn number(value: u64) -> Value {
    Value::Number(value as f64)
}

pub(crate) fn not_an_object() -> ServerError {
    ServerError::invalid("The body must be a JSON object")
}

fn over_window(field: &str, value: Option<&Value>, max_window: u64) -> Outcome<()> {
    let Some(value) = value else {
        return Ok(());
    };
    match value {
        Value::Number(given) if *given > max_window as f64 => Err(detailed(
            format!("Field \"{field}\" exceeds the maximum result window of {max_window}"),
            vec![("value", value.clone()), ("limit", number(max_window))],
        )),
        _ => Ok(()),
    }
}

fn has_custom_reducer(group: Option<&Value>) -> bool {
    match group {
        Some(Value::Object(group)) => group.contains_key("reduce"),
        Some(Value::Array(_)) => true,
        _ => false,
    }
}

fn over_rerank_window(rerank: Option<&Value>, max_rerank_window: u64) -> Outcome<()> {
    let Some(Value::Object(rerank)) = rerank else {
        return Ok(());
    };
    match rerank.get("window") {
        Some(window @ Value::Number(given)) if *given > max_rerank_window as f64 => Err(detailed(
            format!(
                "Field \"rerank.window\" exceeds this server's maximum rerank window of {max_rerank_window}"
            ),
            vec![
                ("value", window.clone()),
                ("limit", number(max_rerank_window)),
            ],
        )),
        _ => Ok(()),
    }
}

pub(crate) fn validate_query(params: &Map, limits: &ResolvedLimits) -> Outcome<()> {
    let max_window = limits.max_result_window;
    if has_custom_reducer(params.get("group")) {
        return Err(ServerError::invalid(
            "Custom group reducers are not available over HTTP; use \"group.fields\" and \"group.maxPerGroup\" only",
        ));
    }
    over_window("limit", params.get("limit"), max_window)?;
    over_window("offset", params.get("offset"), max_window)?;
    over_rerank_window(params.get("rerank"), limits.max_rerank_window)?;
    if let Some(Value::Object(group)) = params.get("group") {
        over_window("group.maxPerGroup", group.get("maxPerGroup"), max_window)?;
        over_window("group.limit", group.get("limit"), max_window)?;
    }
    if let Some(facets) = params.get("facets").and_then(entries_of) {
        for (field, facet) in facets {
            if let Value::Object(facet) = facet {
                over_window(
                    &format!("facets.{field}.limit"),
                    facet.get("limit"),
                    max_window,
                )?;
            }
        }
    }
    Ok(())
}

fn with_server_rerank_window(query: &mut Map, max_rerank_window: u64) {
    let depth = if query.contains_key("vector") {
        match query.get("hybrid") {
            Some(Value::Object(hybrid)) => hybrid.get("depth").and_then(Value::as_f64),
            _ => None,
        }
    } else {
        None
    };
    let fuses =
        query.contains_key("term") || query.get("mode").and_then(Value::as_str) == Some("hybrid");
    let Some(Value::Object(rerank)) = query.get_mut("rerank") else {
        return;
    };
    if rerank.contains_key("window") {
        return;
    }
    let ceiling = max_rerank_window as f64;
    let window = match depth {
        Some(depth) if fuses && depth.is_finite() && depth.fract() == 0.0 => ceiling.min(depth),
        _ => ceiling,
    };
    if window < DEFAULT_RERANK_WINDOW {
        rerank.insert("window", Value::Number(window));
    }
}

fn facet_with_limit(facet: &Value, max_window: u64) -> Value {
    let mut spec = match facet {
        Value::Object(spec) => spec.clone(),
        _ => Map::new(),
    };
    let unset = match spec.get("limit") {
        None => true,
        Some(Value::Number(limit)) => *limit == 0.0,
        Some(_) => false,
    };
    if unset {
        spec.insert("limit", number(max_window));
    }
    Value::Object(spec)
}

pub(crate) fn with_server_query_limits(mut query: Map, limits: &ResolvedLimits) -> Map {
    let max_window = limits.max_result_window;
    if !query.contains_key("limit") {
        query.insert("limit", number(DEFAULT_PAGE_SIZE.min(max_window)));
    }
    if let Some(Value::Object(group)) = query.get_mut("group")
        && group.get("limit").is_none_or(Value::is_null)
    {
        group.insert("limit", number(max_window));
    }
    let facets = query.get("facets").and_then(entries_of).map(|entries| {
        let mut rebuilt = Map::with_capacity(entries.len());
        for (field, facet) in entries {
            rebuilt.insert(field, facet_with_limit(facet, max_window));
        }
        rebuilt
    });
    if let Some(facets) = facets {
        query.insert("facets", Value::Object(facets));
    }
    with_server_rerank_window(&mut query, limits.max_rerank_window);
    query
}

pub(crate) fn validate_suggest(params: &Map) -> Outcome<()> {
    match params.get("prefix") {
        Some(Value::String(_)) => Ok(()),
        _ => Err(ServerError::invalid(
            "Field \"prefix\" is required and must be a string",
        )),
    }
}

fn list_sort_refusal() -> ServerError {
    ServerError::invalid(
        "Field \"sort\" must be an object keyed by field name, or a list of fields",
    )
}

fn optional(key: &'static str, value: Option<&Value>) -> Vec<(&'static str, Value)> {
    value
        .map(|value| (key, value.clone()))
        .into_iter()
        .collect()
}

struct ListSortEntry<'a> {
    field: Option<Value>,
    direction: Option<&'a Value>,
}

fn list_sort_entries(sort: &Value) -> Option<Vec<ListSortEntry<'_>>> {
    match sort {
        Value::Array(items) => Some(
            items
                .iter()
                .map(|entry| match entry {
                    Value::Object(entry) => ListSortEntry {
                        field: entry.get("field").cloned(),
                        direction: entry.get("direction"),
                    },
                    other => ListSortEntry {
                        field: Some(other.clone()),
                        direction: None,
                    },
                })
                .collect(),
        ),
        Value::Object(fields) => Some(
            fields
                .iter()
                .map(|(field, direction)| ListSortEntry {
                    field: Some(Value::String(field.clone())),
                    direction: Some(direction),
                })
                .collect(),
        ),
        _ => None,
    }
}

fn validate_list_sort(sort: Option<&Value>) -> Outcome<()> {
    let Some(sort) = sort else {
        return Ok(());
    };
    let entries = list_sort_entries(sort).ok_or_else(list_sort_refusal)?;
    if entries.len() > MAX_SORT_FIELDS {
        return Err(detailed(
            format!("Field \"sort\" exceeds the maximum of {MAX_SORT_FIELDS} fields"),
            vec![
                ("count", number(entries.len() as u64)),
                ("limit", number(MAX_SORT_FIELDS as u64)),
            ],
        ));
    }
    for entry in &entries {
        let Some(name) = entry
            .field
            .as_ref()
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
        else {
            return Err(detailed(
                "Every entry of \"sort\" must name a field".to_string(),
                optional("value", entry.field.as_ref()),
            ));
        };
        if !matches!(
            entry.direction.and_then(Value::as_str),
            Some("asc" | "desc")
        ) {
            return Err(detailed(
                format!("Field \"sort.{name}\" must be \"asc\" or \"desc\""),
                optional("value", entry.direction),
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_list(params: &Map, max_fetch: u64) -> Outcome<()> {
    if params
        .get("cursor")
        .is_some_and(|cursor| cursor.as_str().is_none())
    {
        return Err(ServerError::invalid("Field \"cursor\" must be a string"));
    }
    match params.get("limit") {
        None => {}
        Some(limit @ Value::Number(given)) => {
            if *given > max_fetch as f64 {
                return Err(detailed(
                    format!(
                        "Field \"limit\" exceeds the maximum of {max_fetch} documents per request"
                    ),
                    vec![("value", limit.clone()), ("limit", number(max_fetch))],
                ));
            }
        }
        Some(_) => return Err(ServerError::invalid("Field \"limit\" must be a number")),
    }
    validate_list_sort(params.get("sort"))
}

pub(crate) fn default_list_limit(limits: &ResolvedLimits) -> u64 {
    DEFAULT_PAGE_SIZE.min(limits.max_fetch_documents)
}
