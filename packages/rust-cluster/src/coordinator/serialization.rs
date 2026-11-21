use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use super::types::{AllocationTable, NodeCapacity, NodeRegistration};
use crate::error::{ClusterError, ClusterResult, codes};

const REGISTRATION_FIELDS: [&str; 6] = [
    "nodeId",
    "address",
    "roles",
    "capacity",
    "startedAt",
    "version",
];

fn invalid(message: &str) -> ClusterError {
    ClusterError::new(codes::CONFIG_INVALID, message)
}

fn decoded_record(data: &[u8], what: &str) -> ClusterResult<Map> {
    match decode_msgpack(data) {
        Ok(Value::Object(record)) => Ok(record),
        Ok(_) => Err(invalid(&format!(
            "The stored {what} is not a MessagePack map"
        ))),
        Err(error) => Err(ClusterError::from(error)),
    }
}

fn encoded(value: &Value) -> ClusterResult<Vec<u8>> {
    encode_msgpack(value).map_err(ClusterError::from)
}

fn number(value: f64) -> Value {
    Value::Number(value)
}

pub(crate) fn encode_registration(registration: &NodeRegistration) -> ClusterResult<Vec<u8>> {
    let mut capacity = Map::with_capacity(3);
    capacity.insert("memoryBytes", number(registration.capacity.memory_bytes));
    capacity.insert("cpuCores", number(registration.capacity.cpu_cores));
    capacity.insert(
        "diskBytes",
        registration.capacity.disk_bytes.map_or(Value::Null, number),
    );
    let mut record = Map::with_capacity(REGISTRATION_FIELDS.len() + registration.extra.len());
    record.insert("nodeId", Value::String(registration.node_id.clone()));
    record.insert("address", Value::String(registration.address.clone()));
    record.insert(
        "roles",
        Value::Array(
            registration
                .roles
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    record.insert("capacity", Value::Object(capacity));
    record.insert("startedAt", Value::String(registration.started_at.clone()));
    record.insert("version", Value::String(registration.version.clone()));
    for (name, value) in registration.extra.iter() {
        if !REGISTRATION_FIELDS.contains(&name.as_str()) {
            record.insert(name.clone(), value.clone());
        }
    }
    encoded(&Value::Object(record))
}

fn text_of(record: &Map, field: &str) -> String {
    record
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn number_of(record: &Map, field: &str) -> Option<f64> {
    match record.get(field) {
        Some(Value::Number(value)) => Some(*value),
        _ => None,
    }
}

pub(crate) fn decode_registration(data: &[u8]) -> ClusterResult<NodeRegistration> {
    let record = decoded_record(data, "node registration")?;
    let Some(node_id) = record.get("nodeId").and_then(Value::as_str) else {
        return Err(invalid("NodeRegistration missing or invalid nodeId field"));
    };
    let Some(address) = record.get("address").and_then(Value::as_str) else {
        return Err(invalid("NodeRegistration missing or invalid address field"));
    };
    let roles = match record.get("roles") {
        Some(Value::Array(roles)) => roles
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    };
    let empty = Map::new();
    let capacity = match record.get("capacity") {
        Some(Value::Object(capacity)) => capacity,
        _ => &empty,
    };
    let mut extra = Map::new();
    for (name, value) in record.iter() {
        if !REGISTRATION_FIELDS.contains(&name.as_str()) && *value != Value::Null {
            extra.insert(name.clone(), value.clone());
        }
    }
    Ok(NodeRegistration {
        node_id: node_id.to_string(),
        address: address.to_string(),
        roles,
        capacity: NodeCapacity {
            memory_bytes: number_of(capacity, "memoryBytes").unwrap_or(0.0),
            cpu_cores: number_of(capacity, "cpuCores").unwrap_or(0.0),
            disk_bytes: number_of(capacity, "diskBytes"),
        },
        started_at: text_of(&record, "startedAt"),
        version: text_of(&record, "version"),
        extra,
    })
}

pub(crate) fn encode_allocation(table: &AllocationTable) -> ClusterResult<Vec<u8>> {
    let mut record = Map::with_capacity(6);
    record.insert("indexName", Value::String(table.index_name.clone()));
    record.insert("version", number(table.version));
    record.insert("replicationFactor", number(table.replication_factor));
    let assignments = table
        .assignments
        .iter()
        .map(|(partition_id, assignment)| {
            Value::Array(vec![
                number(*partition_id),
                Value::Object(assignment.clone()),
            ])
        })
        .collect();
    record.insert("assignments", Value::Array(assignments));
    if let Some(generation) = &table.generation {
        record.insert("generation", Value::String(generation.clone()));
    }
    if let Some(index_uuid) = &table.index_uuid {
        record.insert("indexUuid", Value::String(index_uuid.clone()));
    }
    encoded(&Value::Object(record))
}

fn strings_of(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(entries)) => entries
            .iter()
            .filter(|entry| matches!(entry, Value::String(_)))
            .cloned()
            .collect(),
        _ => Vec::new(),
    }
}

fn last_holders(candidate: &Map) -> Vec<Value> {
    let stored = strings_of(candidate.get("lastHolders"));
    if !stored.is_empty() || matches!(candidate.get("lastHolders"), Some(Value::Array(_))) {
        return stored;
    }
    if candidate.get("state").and_then(Value::as_str) == Some("UNASSIGNED") {
        return strings_of(candidate.get("inSyncSet"));
    }
    Vec::new()
}

fn set_or_drop(record: &mut Map, field: &str, entries: Vec<Value>) {
    if entries.is_empty() {
        record.remove(field);
    } else {
        record.insert(field, Value::Array(entries));
    }
}

fn normalised_assignment(pair: &Value) -> ClusterResult<(f64, Map)> {
    let Value::Array(pair) = pair else {
        return Err(invalid(
            "AllocationTable holds a malformed assignment entry",
        ));
    };
    if pair.len() < 2 {
        return Err(invalid(
            "AllocationTable holds a malformed assignment entry",
        ));
    }
    let (Value::Number(partition_id), Value::Object(candidate)) = (&pair[0], &pair[1]) else {
        return Err(invalid(
            "AllocationTable holds a malformed partition assignment",
        ));
    };
    let commit_point = match candidate.get("commitPoint") {
        Some(Value::Number(point))
            if point.fract() == 0.0
                && *point >= 0.0
                && *point <= crate::constants::MAX_SAFE_INTEGER as f64 =>
        {
            *point
        }
        _ => 0.0,
    };
    let holders = last_holders(candidate);
    let removing = strings_of(candidate.get("removingReplicas"));
    let mut assignment = candidate.clone();
    let primary = match candidate.get("primary") {
        None | Some(Value::Null) => Value::Null,
        Some(primary) => primary.clone(),
    };
    assignment.insert("primary", primary);
    assignment.insert("commitPoint", number(commit_point));
    set_or_drop(&mut assignment, "lastHolders", holders);
    set_or_drop(&mut assignment, "removingReplicas", removing);
    Ok((*partition_id, assignment))
}

pub(crate) fn decode_allocation(data: &[u8]) -> ClusterResult<AllocationTable> {
    let record = decoded_record(data, "allocation table")?;
    let Some(index_name) = record.get("indexName").and_then(Value::as_str) else {
        return Err(invalid(
            "AllocationTable missing or invalid indexName field",
        ));
    };
    let Some(version) = number_of(&record, "version") else {
        return Err(invalid("AllocationTable missing or invalid version field"));
    };
    let Some(Value::Array(entries)) = record.get("assignments") else {
        return Err(invalid(
            "AllocationTable missing or invalid assignments field",
        ));
    };
    let mut assignments: Vec<(f64, Map)> = Vec::with_capacity(entries.len());
    for entry in entries {
        let (partition_id, assignment) = normalised_assignment(entry)?;
        match assignments
            .iter_mut()
            .find(|(held, _)| *held == partition_id)
        {
            Some(slot) => slot.1 = assignment,
            None => assignments.push((partition_id, assignment)),
        }
    }
    let non_empty = |field: &str| {
        record
            .get(field)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    Ok(AllocationTable {
        index_name: index_name.to_string(),
        version,
        replication_factor: number_of(&record, "replicationFactor").unwrap_or(0.0),
        assignments,
        generation: non_empty("generation"),
        index_uuid: non_empty("indexUuid"),
    })
}

pub(crate) fn encode_schema(schema: &Value) -> ClusterResult<Vec<u8>> {
    encoded(schema)
}

pub(crate) fn decode_schema(data: &[u8]) -> ClusterResult<Value> {
    decode_msgpack(data).map_err(ClusterError::from)
}
