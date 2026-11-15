use std::cmp::Ordering;

use narsil::{Map, Value};

use super::javascript_number::number_of_text;
use super::store::{TASK_TYPES, TaskRecord, TaskStatus};
use crate::constants::DEFAULT_TASK_PAGE_SIZE;
use crate::errors::ServerError;

const TASK_STATUSES: [&str; 4] = ["running", "succeeded", "failed", "cancelled"];

pub(crate) struct TaskListQuery {
    pub(crate) index_name: Option<String>,
    pub(crate) types: Option<Vec<String>>,
    pub(crate) statuses: Option<Vec<String>>,
    pub(crate) from: f64,
    pub(crate) limit: f64,
}

pub(crate) struct TaskListPage {
    pub(crate) tasks: Vec<TaskRecord>,
    pub(crate) total: usize,
    pub(crate) from: f64,
    pub(crate) limit: f64,
    pub(crate) next: Option<f64>,
}

impl TaskListPage {
    pub(crate) fn to_wire(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            "tasks",
            Value::Array(self.tasks.iter().map(TaskRecord::to_wire).collect()),
        );
        out.insert("total", Value::Number(self.total as f64));
        out.insert("from", Value::Number(self.from));
        out.insert("limit", Value::Number(self.limit));
        out.insert("next", self.next.map_or(Value::Null, Value::Number));
        Value::Object(out)
    }
}

fn is_javascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

pub(crate) fn javascript_trim(text: &str) -> &str {
    text.trim_matches(is_javascript_whitespace)
}

fn list_param(
    raw: Option<&str>,
    field: &str,
    allowed: &[&str],
) -> Result<Option<Vec<String>>, ServerError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let requested: Vec<String> = raw
        .split(',')
        .map(|entry| javascript_trim(entry).to_string())
        .collect();
    let unknown: Vec<Value> = requested
        .iter()
        .filter(|entry| !allowed.contains(&entry.as_str()))
        .map(|entry| Value::String(entry.clone()))
        .collect();
    if unknown.is_empty() {
        return Ok(Some(requested));
    }
    Err(ServerError::invalid(format!(
        "Query parameter \"{field}\" accepts only {}",
        allowed.join(", ")
    ))
    .with_detail("unknown", Value::Array(unknown)))
}

fn count_param(raw: Option<&str>, field: &str, minimum: f64) -> Result<f64, ServerError> {
    let Some(raw) = raw else {
        return Ok(minimum);
    };
    let value = number_of_text(raw);
    if value.is_finite() && value.trunc() == value && value >= minimum {
        return Ok(value);
    }
    Err(ServerError::invalid(format!(
        "Query parameter \"{field}\" must be an integer of {minimum} or more"
    ))
    .with_detail("value", Value::String(raw.to_string())))
}

pub(crate) fn parse_task_list_query(
    value_of: impl Fn(&str) -> Option<String>,
    max_page_size: u64,
) -> Result<TaskListQuery, ServerError> {
    let types = list_param(value_of("type").as_deref(), "type", &TASK_TYPES)?;
    let statuses = list_param(value_of("status").as_deref(), "status", &TASK_STATUSES)?;
    let from = count_param(value_of("from").as_deref(), "from", 0.0)?;
    let raw_limit = value_of("limit");
    let limit = count_param(raw_limit.as_deref(), "limit", 1.0)?;
    let max = max_page_size as f64;
    if raw_limit.is_some() && limit > max {
        let mut details = Map::new();
        details.insert("value", Value::Number(limit));
        details.insert("limit", Value::Number(max));
        return Err(ServerError::invalid(format!(
            "Query parameter \"limit\" exceeds the maximum page size of {max_page_size}"
        ))
        .with_details(details));
    }
    Ok(TaskListQuery {
        index_name: value_of("indexName"),
        types,
        statuses,
        from,
        limit: if raw_limit.is_some() {
            limit
        } else {
            (DEFAULT_TASK_PAGE_SIZE as f64).min(max)
        },
    })
}

fn matches(record: &TaskRecord, query: &TaskListQuery) -> bool {
    if query
        .index_name
        .as_ref()
        .is_some_and(|name| *name != record.index_name)
    {
        return false;
    }
    if let Some(types) = &query.types
        && !types.is_empty()
        && !types.contains(&record.task_type)
    {
        return false;
    }
    if let Some(statuses) = &query.statuses
        && !statuses.is_empty()
        && !statuses
            .iter()
            .any(|status| TaskStatus::from_wire(status) == Some(record.status))
    {
        return false;
    }
    true
}

fn newest_first(left: &TaskRecord, right: &TaskRecord) -> Ordering {
    right
        .created_at
        .total_cmp(&left.created_at)
        .then_with(|| left.id.cmp(&right.id))
}

fn position_of(offset: f64, length: usize) -> usize {
    if offset >= length as f64 {
        length
    } else {
        offset as usize
    }
}

pub(crate) fn page_of(records: Vec<TaskRecord>, query: &TaskListQuery) -> TaskListPage {
    let from = if query.from > 0.0 {
        query.from.trunc()
    } else {
        0.0
    };
    let limit = if query.limit > 1.0 {
        query.limit.trunc()
    } else {
        1.0
    };
    let mut matched: Vec<TaskRecord> = records
        .into_iter()
        .filter(|record| matches(record, query))
        .collect();
    matched.sort_by(newest_first);
    let total = matched.len();
    let start = position_of(from, total);
    let end = position_of(from + limit, total);
    let tasks: Vec<TaskRecord> = matched.drain(start..end.max(start)).collect();
    let consumed = from + tasks.len() as f64;
    TaskListPage {
        next: (consumed < total as f64).then_some(consumed),
        tasks,
        total,
        from,
        limit,
    }
}
