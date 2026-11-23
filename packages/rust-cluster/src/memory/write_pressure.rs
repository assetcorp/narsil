use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use narsil::{Map, Value};

use crate::constants::{
    DOCUMENT_ENTRY_OVERHEAD_BYTES, DOCUMENT_NUMBER_BYTES, DOCUMENT_SCALAR_BYTES,
};
use crate::error::{ClusterError, codes};
use crate::payload::forward::ForwardOperation;

const WRITE_BYTES_IN_FLIGHT_REASON: &str = "write_bytes_in_flight";

pub(crate) struct WritePressure {
    node_id: String,
    limit_bytes: u64,
    in_flight: Arc<AtomicU64>,
}

pub(crate) struct AdmittedWrite {
    in_flight: Arc<AtomicU64>,
    bytes: u64,
}

impl Drop for AdmittedWrite {
    fn drop(&mut self) {
        self.in_flight.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

impl WritePressure {
    pub(crate) fn new(node_id: String, limit_bytes: u64) -> WritePressure {
        WritePressure {
            node_id,
            limit_bytes,
            in_flight: Arc::new(AtomicU64::new(0)),
        }
    }

    pub(crate) fn admit(
        &self,
        index_name: &str,
        bytes: u64,
    ) -> Result<AdmittedWrite, ClusterError> {
        let mut in_flight = self.in_flight.load(Ordering::Acquire);
        loop {
            if in_flight > 0 && in_flight.saturating_add(bytes) > self.limit_bytes {
                return Err(self.refusal(index_name, bytes, in_flight));
            }
            match self.in_flight.compare_exchange_weak(
                in_flight,
                in_flight.saturating_add(bytes),
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Ok(AdmittedWrite {
                        in_flight: Arc::clone(&self.in_flight),
                        bytes,
                    });
                }
                Err(current) => in_flight = current,
            }
        }
    }

    fn refusal(&self, index_name: &str, request_bytes: u64, in_flight: u64) -> ClusterError {
        let node_id = &self.node_id;
        let limit_bytes = self.limit_bytes;
        ClusterError::new(
            codes::CLUSTER_WRITE_BLOCKED,
            format!(
                "Node '{node_id}' refuses this write to index '{index_name}' because its {request_bytes} bytes would take the writes in flight on the node from {in_flight} bytes past the limit of {limit_bytes} bytes. Retry once the writes in flight finish, or send smaller batches."
            ),
        )
        .with_detail("reason", Value::from(WRITE_BYTES_IN_FLIGHT_REASON))
        .with_detail("indexName", Value::from(index_name))
        .with_detail("nodeId", Value::from(node_id.as_str()))
        .with_detail("requestBytes", Value::Number(request_bytes as f64))
        .with_detail("inFlightBytes", Value::Number(in_flight as f64))
        .with_detail("limitBytes", Value::Number(limit_bytes as f64))
    }
}

fn text_units(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

pub(crate) fn estimate_document_bytes(document: &Map) -> u64 {
    let mut bytes = 0u64;
    let mut pending: Vec<&Value> = Vec::new();
    for (key, item) in document.iter() {
        bytes = bytes.saturating_add(text_units(key) + DOCUMENT_ENTRY_OVERHEAD_BYTES);
        pending.push(item);
    }
    while let Some(value) = pending.pop() {
        let added = match value {
            Value::String(text) => text_units(text),
            Value::Number(_) | Value::Timestamp(_) => DOCUMENT_NUMBER_BYTES,
            Value::Null | Value::Bool(_) => DOCUMENT_SCALAR_BYTES,
            Value::Bytes(raw) => raw.len() as u64,
            Value::Array(items) => {
                pending.extend(items.iter());
                DOCUMENT_ENTRY_OVERHEAD_BYTES
            }
            Value::Object(fields) => {
                let mut keys = 0u64;
                for (key, item) in fields.iter() {
                    keys = keys.saturating_add(text_units(key) + DOCUMENT_ENTRY_OVERHEAD_BYTES);
                    pending.push(item);
                }
                keys
            }
        };
        bytes = bytes.saturating_add(added);
    }
    bytes
}

pub(crate) fn estimate_forwarded_bytes(operation: &ForwardOperation) -> u64 {
    let document_bytes = operation
        .document
        .as_ref()
        .map_or(0, |document| document.len() as u64);
    match &operation.update_fields {
        None => document_bytes,
        Some(fields) => document_bytes.saturating_add(estimate_document_bytes(fields)),
    }
}
