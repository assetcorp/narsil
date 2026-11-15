use narsil::{ListParams, Map, SuggestParams, Value};

use super::query::projection;
use super::reader::Converted;

fn clamped_row_count(value: Option<&Value>) -> Option<usize> {
    match value {
        Some(Value::Number(count)) if count.is_finite() => Some(count.max(0.0).floor() as usize),
        _ => None,
    }
}

pub(crate) fn list_params(params: &Map, default_limit: u64) -> Converted<ListParams> {
    let limit = match params.get("limit") {
        None => Some(usize::try_from(default_limit).unwrap_or(usize::MAX)),
        given => clamped_row_count(given),
    };
    Ok(ListParams {
        cursor: params
            .get("cursor")
            .and_then(Value::as_str)
            .map(str::to_string),
        limit,
        filters: params
            .get("filters")
            .filter(|filters| !filters.is_null())
            .cloned(),
        document: params
            .get("document")
            .filter(|document| !document.is_null())
            .map(projection)
            .transpose()?,
    })
}

pub(crate) fn suggest_params(params: &Map) -> SuggestParams {
    SuggestParams {
        prefix: params
            .get("prefix")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        limit: clamped_row_count(params.get("limit")),
    }
}
