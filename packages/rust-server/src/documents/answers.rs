use std::collections::BTreeMap;
use std::io;

use bytes::Bytes;
use narsil::{
    IndexInfo, IndexResidencyState, IndexStats, Map, MemoryStats, PartitionStats, Value,
    write_plain_json_into,
};
use tokio::sync::mpsc;

use super::constants::{RESPONSE_GROUP_BYTES, RESPONSE_GROUP_DOCUMENTS, RESPONSE_GROUPS_IN_FLIGHT};
use crate::constants::JSON_CONTENT_TYPE;
use crate::http::respond::{HttpResponse, json, stream};

const PROTOTYPE_KEY: &str = "__proto__";

fn count(value: u64) -> Value {
    Value::Number(value as f64)
}

fn state_name(state: IndexResidencyState) -> &'static str {
    match state {
        IndexResidencyState::Open => "open",
        IndexResidencyState::Closed => "closed",
        IndexResidencyState::ReopenFailed => "reopen-failed",
    }
}

pub(crate) fn index_info(info: &IndexInfo) -> Value {
    let mut entry = Map::with_capacity(7);
    entry.insert("name", Value::String(info.name.clone()));
    entry.insert("documentCount", count(info.document_count));
    entry.insert("partitionCount", count(info.partition_count as u64));
    entry.insert("language", Value::String(info.language.clone()));
    entry.insert("state", Value::String(state_name(info.state).to_string()));
    entry.insert("reopenCount", count(info.reopen_count));
    if info.analysis_stale {
        entry.insert("analysisStale", Value::Bool(true));
    }
    Value::Object(entry)
}

pub(crate) fn index_stats(stats: IndexStats) -> Value {
    let mut entry = Map::with_capacity(8);
    entry.insert("documentCount", count(stats.document_count));
    entry.insert("partitionCount", count(stats.partition_count as u64));
    entry.insert("estimatedMemoryBytes", count(stats.estimated_memory_bytes));
    if let Some(saved) = stats.saved_bytes {
        entry.insert("savedBytes", count(saved));
    }
    if let Some(logged) = stats.log_bytes {
        entry.insert("logBytes", count(logged));
    }
    entry.insert("language", Value::String(stats.language));
    entry.insert("schema", stats.schema);
    entry.insert("heldSearchStates", count(0));
    Value::Object(entry)
}

pub(crate) fn partition_stats(partitions: Vec<PartitionStats>) -> Value {
    let listed = partitions
        .into_iter()
        .map(|partition| {
            let mut entry = Map::with_capacity(5);
            entry.insert("partitionId", count(partition.partition_id as u64));
            entry.insert("documentCount", count(partition.document_count));
            entry.insert(
                "estimatedMemoryBytes",
                count(partition.estimated_memory_bytes),
            );
            if let Some(saved) = partition.saved_bytes {
                entry.insert("savedBytes", count(saved));
            }
            if let Some(logged) = partition.log_bytes {
                entry.insert("logBytes", count(logged));
            }
            Value::Object(entry)
        })
        .collect();
    let mut body = Map::with_capacity(1);
    body.insert("partitions", Value::Array(listed));
    Value::Object(body)
}

fn process_report(stats: &MemoryStats) -> Value {
    let Some(resident) = stats.process_resident_bytes else {
        return Value::Null;
    };
    let mut process = Map::with_capacity(5);
    process.insert("heapUsed", count(resident));
    process.insert("heapTotal", count(resident));
    process.insert(
        "heapLimit",
        stats.process_limit_bytes.map_or(Value::Null, count),
    );
    process.insert("external", count(0));
    process.insert("rss", count(resident));
    Value::Object(process)
}

fn worker_copy(info: &IndexInfo) -> Value {
    let mut entry = Map::with_capacity(3);
    entry.insert("indexName", Value::String(info.name.clone()));
    entry.insert("scaledOut", Value::Bool(false));
    entry.insert("reloadCount", count(0));
    Value::Object(entry)
}

pub(crate) fn memory_stats(stats: &MemoryStats, indexes: &[IndexInfo]) -> Value {
    let closed = indexes
        .iter()
        .filter(|info| info.state != IndexResidencyState::Open)
        .count();
    let reopens = indexes
        .iter()
        .fold(0u64, |total, info| total.saturating_add(info.reopen_count));
    let mut body = Map::with_capacity(9);
    body.insert("process", process_report(stats));
    body.insert("estimatedIndexBytes", count(stats.estimated_index_bytes));
    body.insert("openIndexCount", count(stats.open_index_count as u64));
    body.insert("closedIndexCount", count(closed as u64));
    body.insert("reopenCount", count(reopens));
    body.insert(
        "workerCopies",
        Value::Array(indexes.iter().map(worker_copy).collect()),
    );
    body.insert("heldCheckpoints", Value::Array(Vec::new()));
    body.insert("workers", Value::Array(Vec::new()));
    body.insert("requestThreads", count(0));
    Value::Object(body)
}

pub(crate) fn ordered_documents(wanted: &[String], mut found: BTreeMap<String, Map>) -> Map {
    let mut documents = Map::with_capacity(found.len());
    for id in wanted {
        if id == PROTOTYPE_KEY {
            continue;
        }
        if let Some(document) = found.remove(id) {
            documents.insert(id.clone(), Value::Object(document));
        }
    }
    documents
}

fn encoded_entry(out: &mut String, key: &str, document: &Value) {
    write_plain_json_into(out, &Value::String(key.to_string()));
    out.push(':');
    write_plain_json_into(out, document);
}

fn send_groups(documents: Map, sender: mpsc::Sender<io::Result<Bytes>>) {
    let mut text = String::from("{\"documents\":{");
    let mut grouped = 0;
    let mut first = true;
    for (key, document) in documents.iter() {
        if !first {
            text.push(',');
        }
        first = false;
        encoded_entry(&mut text, key, document);
        grouped += 1;
        if grouped >= RESPONSE_GROUP_DOCUMENTS || text.len() >= RESPONSE_GROUP_BYTES {
            let chunk = Bytes::from(std::mem::take(&mut text));
            if sender.blocking_send(Ok(chunk)).is_err() {
                return;
            }
            grouped = 0;
        }
    }
    text.push_str("}}");
    let _ = sender.blocking_send(Ok(Bytes::from(text)));
}

pub(crate) fn documents_answer(documents: Map) -> HttpResponse {
    if documents.len() <= RESPONSE_GROUP_DOCUMENTS {
        let mut body = Map::with_capacity(1);
        body.insert("documents", Value::Object(documents));
        return json(200, &Value::Object(body));
    }
    let (sender, receiver) = mpsc::channel(RESPONSE_GROUPS_IN_FLIGHT);
    tokio::task::spawn_blocking(move || send_groups(documents, sender));
    stream(200, JSON_CONTENT_TYPE, receiver)
}
