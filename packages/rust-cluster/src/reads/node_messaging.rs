use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use super::ReadDeps;
use super::decode_room::refuse_decode_without_room;
use super::routable_allocation::live_allocation_once;
use crate::allocator::Table;
use crate::constants::FETCH_GROUP_DOCUMENT_IDS;
use crate::data::{LocalReads, routed_partition};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{CARRIER_ERROR_TYPE, ERROR_TYPE_SUFFIX, TransportMessage, message_types};
use crate::node::generate_node_id;
use crate::query::failover::{Attempt, Failure, node_rejection_of, send_to_every_partition};
use crate::query::results::validate_fetch_result_payload;
use crate::query::selection::{PartitionRouting, RandomSelector, copies_in_selection_order};

const TARGET_NODE_ID: &str = "targetNodeId";
const TRANSPORT_CODE: &str = "transportCode";
const FLOAT32_BYTES: usize = 4;

pub(crate) struct SendFailureContext {
    pub(crate) message: String,
    pub(crate) index_name: Option<String>,
}

fn failure_code_by_transport_code(code: &str) -> Option<&'static str> {
    match code {
        codes::TRANSPORT_CONNECT_FAILED | codes::TRANSPORT_PEER_UNAVAILABLE => {
            Some(codes::QUERY_NO_ACTIVE_REPLICA)
        }
        codes::TRANSPORT_TIMEOUT => Some(codes::QUERY_NODE_TIMEOUT),
        codes::TRANSPORT_MESSAGE_TOO_LARGE | codes::TRANSPORT_DECODE_FAILED => {
            Some(codes::QUERY_ROUTING_FAILED)
        }
        _ => None,
    }
}

fn error_from_transport_failure(
    error: ClusterError,
    target_node_id: &str,
    failure: &SendFailureContext,
) -> ClusterError {
    let Some(code) = failure_code_by_transport_code(error.code()) else {
        return error;
    };
    let mut mapped = ClusterError::new(code, failure.message.clone())
        .with_detail(TARGET_NODE_ID, Value::from(target_node_id));
    if let Some(index_name) = &failure.index_name {
        mapped = mapped.with_detail("indexName", Value::from(index_name.as_str()));
    }
    mapped.with_detail(TRANSPORT_CODE, Value::from(error.code()))
}

pub(crate) fn request(
    deps: &ReadDeps,
    message_type: &str,
    payload: &Map,
) -> ClusterResult<TransportMessage> {
    let encoded = encode_msgpack(&Value::Object(payload.clone())).map_err(ClusterError::from)?;
    Ok(TransportMessage::new(
        message_type,
        deps.node_id.as_str(),
        generate_node_id()?,
        encoded,
    ))
}

pub(crate) async fn send_to_node(
    deps: &ReadDeps,
    target_node_id: &str,
    message: &TransportMessage,
    failure: &SendFailureContext,
) -> ClusterResult<TransportMessage> {
    if target_node_id == deps.node_id
        && LocalReads::answers(&message.message_type)
        && let Some(local) = &deps.local
    {
        return Ok(local.answer(message).await);
    }
    let mut last_error = None;
    for target in deps.view.targets(target_node_id) {
        match deps.transport.send(&target, message.clone()).await {
            Ok(answer) if answer.message_type == CARRIER_ERROR_TYPE => {
                last_error = answer.failure();
            }
            Ok(answer) => return Ok(answer),
            Err(error) => last_error = Some(error),
        }
    }
    let error = last_error.unwrap_or_else(|| {
        ClusterError::new(
            codes::TRANSPORT_CONNECT_FAILED,
            format!("Node '{target_node_id}' has no address to send to"),
        )
    });
    Err(error_from_transport_failure(error, target_node_id, failure))
}

pub(crate) fn remote_error_details(value: Option<&Value>) -> Map {
    match value {
        Some(Value::Object(details)) => details.clone(),
        _ => Map::new(),
    }
}

pub(crate) fn read_rejection_of(decoded: &Map, target_node_id: &str, index_name: &str) -> Failure {
    let mut details = remote_error_details(decoded.get("details"));
    details.insert("indexName", Value::from(index_name));
    details.insert(TARGET_NODE_ID, Value::from(target_node_id));
    let code = decoded.get("code").and_then(Value::as_str);
    let message = decoded.get("message").and_then(Value::as_str);
    if let Some(rejection) = node_rejection_of(code, message, &details) {
        return rejection;
    }
    let mut error = ClusterError::new(
        code.unwrap_or(codes::QUERY_ROUTING_FAILED),
        message.map(str::to_string).unwrap_or_else(|| {
            format!("Node '{target_node_id}' rejected a read request for index '{index_name}'")
        }),
    );
    for (key, value) in details.iter() {
        error = error.with_detail(key, value.clone());
    }
    Failure::of(error)
}

pub(crate) fn decoded_answer(answer: &TransportMessage) -> ClusterResult<Map> {
    match decode_msgpack(&answer.payload) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Ok(Map::new()),
        Err(error) => Err(ClusterError::from(error)),
    }
}

pub(crate) fn answer_is_refusal(answer: &TransportMessage, decoded: &Map) -> bool {
    answer.message_type.ends_with(ERROR_TYPE_SUFFIX)
        || answer.message_type == CARRIER_ERROR_TYPE
        || decoded.get("error") == Some(&Value::Bool(true))
}

pub(crate) fn restore_vector_values(value: &mut Value) {
    match value {
        Value::Bytes(bytes) if bytes.len() % FLOAT32_BYTES == 0 => {
            let (values, _) = bytes.as_chunks::<FLOAT32_BYTES>();
            *value = Value::Array(
                values
                    .iter()
                    .map(|value| Value::Number(f64::from(f32::from_le_bytes(*value))))
                    .collect(),
            );
        }
        Value::Array(items) => items.iter_mut().for_each(restore_vector_values),
        Value::Object(map) => {
            for (_, child) in map.iter_mut() {
                restore_vector_values(child);
            }
        }
        _ => {}
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct CopyRead {
    pub(crate) fields: Option<Vec<String>>,
    pub(crate) vectors: bool,
}

struct DocumentRouting {
    routing: PartitionRouting,
    ids_by_partition: HashMap<u32, Vec<String>>,
}

fn route_document_ids(document_ids: &[String], table: &Table) -> DocumentRouting {
    let partition_count = table.assignments.len();
    let mut routing = PartitionRouting::default();
    let mut ids_by_partition: HashMap<u32, Vec<String>> = HashMap::new();
    let mut seen = HashSet::new();
    for document_id in document_ids {
        if !seen.insert(document_id.as_str()) {
            continue;
        }
        let partition_id = routed_partition(document_id, partition_count.max(1));
        if let Some(known) = ids_by_partition.get_mut(&partition_id) {
            known.push(document_id.clone());
            continue;
        }
        let copies = table
            .assignments
            .get(f64::from(partition_id))
            .map(|assignment| copies_in_selection_order(assignment, &RandomSelector, partition_id))
            .unwrap_or_default();
        let Some(first_copy) = copies.first().cloned() else {
            if !routing.unavailable_partitions.contains(&partition_id) {
                routing.unavailable_partitions.push(partition_id);
            }
            continue;
        };
        ids_by_partition.insert(partition_id, vec![document_id.clone()]);
        routing.copies_by_partition.insert(partition_id, copies);
        routing.add_to_node(&first_copy, partition_id);
    }
    DocumentRouting {
        routing,
        ids_by_partition,
    }
}

fn fetch_payload(
    index_name: &str,
    chunk: &[(String, u32)],
    read: &CopyRead,
    context: Option<(&str, bool)>,
) -> Map {
    let mut payload = Map::with_capacity(7);
    payload.insert("indexName", Value::from(index_name));
    payload.insert(
        "documentIds",
        Value::Array(
            chunk
                .iter()
                .map(|(document_id, partition_id)| {
                    let mut entry = Map::with_capacity(2);
                    entry.insert("docId", Value::from(document_id.as_str()));
                    entry.insert("partitionId", Value::from(*partition_id));
                    Value::Object(entry)
                })
                .collect(),
        ),
    );
    payload.insert(
        "fields",
        match &read.fields {
            Some(fields) => Value::Array(
                fields
                    .iter()
                    .map(|field| Value::from(field.as_str()))
                    .collect(),
            ),
            None => Value::Null,
        },
    );
    if !read.vectors {
        payload.insert("vectors", Value::Bool(false));
    }
    payload.insert("highlight", Value::Null);
    if let Some((context_id, release_context)) = context {
        payload.insert("contextId", Value::from(context_id));
        payload.insert("releaseContext", Value::Bool(release_context));
    }
    payload
}

pub(crate) async fn fetch_documents(
    deps: &ReadDeps,
    target_node_id: &str,
    index_name: &str,
    chunk: &[(String, u32)],
    read: &CopyRead,
    context: Option<(&str, bool)>,
) -> Result<Vec<(String, Map)>, Failure> {
    let payload = fetch_payload(index_name, chunk, read, context);
    let message = request(deps, message_types::QUERY_FETCH, &payload)?;
    let answer = send_to_node(
        deps,
        target_node_id,
        &message,
        &SendFailureContext {
            message: format!(
                "Node '{target_node_id}' did not answer a document fetch for index '{index_name}'"
            ),
            index_name: Some(index_name.to_string()),
        },
    )
    .await?;
    refuse_decode_without_room(deps, &answer.payload)?;
    let decoded = decoded_answer(&answer)?;
    if answer_is_refusal(&answer, &decoded) {
        return Err(read_rejection_of(&decoded, target_node_id, index_name));
    }
    Ok(validate_fetch_result_payload(decoded)?)
}

async fn read_local(
    deps: &ReadDeps,
    index_name: &str,
    document_ids: Vec<String>,
    read: &CopyRead,
) -> ClusterResult<Vec<(String, Map)>> {
    let Some(local) = &deps.local else {
        return Ok(Vec::new());
    };
    local
        .get_multiple(index_name, document_ids, read.vectors)
        .await
}

async fn read_from_copies(
    deps: Arc<ReadDeps>,
    index_name: &str,
    document_routing: DocumentRouting,
    read: CopyRead,
) -> Result<BTreeMap<String, Map>, Failure> {
    let ids_by_partition = Arc::new(document_routing.ids_by_partition);
    let index: Arc<str> = Arc::from(index_name);
    let read = Arc::new(read);
    let attempt_deps = Arc::clone(&deps);
    let attempt: Attempt<Vec<(String, Map)>> = Arc::new(move |target_node_id, partition_ids| {
        let deps = Arc::clone(&attempt_deps);
        let ids_by_partition = Arc::clone(&ids_by_partition);
        let index = Arc::clone(&index);
        let read = Arc::clone(&read);
        Box::pin(async move {
            let document_ids: Vec<(String, u32)> = partition_ids
                .iter()
                .flat_map(|partition_id| {
                    ids_by_partition
                        .get(partition_id)
                        .into_iter()
                        .flatten()
                        .map(|document_id| (document_id.clone(), *partition_id))
                })
                .collect();
            if target_node_id == deps.node_id {
                let ids = document_ids.into_iter().map(|(id, _)| id).collect();
                return Ok(Some(read_local(&deps, &index, ids, &read).await?));
            }
            let mut found = Vec::with_capacity(document_ids.len());
            for chunk in document_ids.chunks(FETCH_GROUP_DOCUMENT_IDS) {
                let fetched =
                    fetch_documents(&deps, &target_node_id, &index, chunk, &read, None).await?;
                found.extend(fetched);
            }
            Ok(Some(found))
        })
    });
    let answered = send_to_every_partition(&document_routing.routing, attempt).await?;
    let mut documents = BTreeMap::new();
    for answer in answered {
        for (document_id, document) in answer {
            documents.insert(document_id, document);
        }
    }
    Ok(documents)
}

pub(crate) fn no_active_replica(index_name: &str, partition_ids: &[u32]) -> ClusterError {
    let mut sorted = partition_ids.to_vec();
    sorted.sort_unstable();
    ClusterError::new(
        codes::QUERY_NO_ACTIVE_REPLICA,
        format!("No active replica serves one or more partitions of index '{index_name}'"),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail(
        "partitionIds",
        Value::Array(sorted.into_iter().map(Value::from).collect()),
    )
}

pub(crate) async fn read_documents_from_copies(
    deps: &Arc<ReadDeps>,
    index_name: &str,
    document_ids: &[String],
    table: &Table,
    read: CopyRead,
    require_every_partition: bool,
    read_live: bool,
) -> Result<BTreeMap<String, Map>, Failure> {
    let mut document_routing = route_document_ids(document_ids, table);
    if require_every_partition
        && read_live
        && !document_routing.routing.unavailable_partitions.is_empty()
        && let Some(live) = live_allocation_once(deps, index_name).await
    {
        document_routing = route_document_ids(document_ids, &live);
    }
    let unreachable = &document_routing.routing.unavailable_partitions;
    if require_every_partition && !unreachable.is_empty() {
        return Err(Failure::of(no_active_replica(index_name, unreachable)));
    }
    read_from_copies(Arc::clone(deps), index_name, document_routing, read).await
}
