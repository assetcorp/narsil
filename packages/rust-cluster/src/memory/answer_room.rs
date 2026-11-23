use narsil::Value;
use narsil::replication::NodeMemoryReading;

use super::NodeMemory;
use crate::constants::ANSWER_MEMORY_BLOCK_FRACTION;
use crate::error::{ClusterError, codes};

const RESPONSE_WOULD_FILL_MEMORY_REASON: &str = "response_would_fill_memory";

fn block_bytes_of(reading: &NodeMemoryReading) -> f64 {
    ANSWER_MEMORY_BLOCK_FRACTION * reading.process_limit_bytes as f64
}

fn room_in(reading: &NodeMemoryReading, reserved_bytes: u64) -> f64 {
    block_bytes_of(reading) - reading.process_bytes as f64 - reserved_bytes as f64
}

fn refusal(answer_bytes: u64, reading: &NodeMemoryReading, reserved_bytes: u64) -> ClusterError {
    let block_bytes = block_bytes_of(reading).floor();
    let used_bytes = reading.process_bytes;
    let number = |bytes: u64| Value::Number(bytes as f64);
    ClusterError::new(
        codes::TOO_MANY_REQUESTS,
        format!(
            "Building the next {answer_bytes} bytes of this answer would take the {used_bytes} bytes already in use past the limit of {block_bytes} bytes. Retry once the requests in progress finish, or ask for fewer documents."
        ),
    )
    .with_detail("reason", Value::from(RESPONSE_WOULD_FILL_MEMORY_REASON))
    .with_detail("answerBytes", number(answer_bytes))
    .with_detail("heapBytes", number(used_bytes))
    .with_detail("heapCommittedBytes", number(used_bytes))
    .with_detail("youngHeapBytes", number(0))
    .with_detail("processBytes", number(used_bytes))
    .with_detail("reservedBytes", number(reserved_bytes))
    .with_detail("blockBytes", Value::Number(block_bytes))
    .with_detail("collectedGarbage", Value::Bool(false))
}

pub(crate) fn answer_refusal_of(
    memory: &NodeMemory,
    answer_bytes: u64,
    reserved_bytes: u64,
) -> Option<ClusterError> {
    let fits =
        |reading: &NodeMemoryReading| answer_bytes as f64 <= room_in(reading, reserved_bytes);
    let recent = memory.recent_reading()?;
    if fits(&recent) {
        return None;
    }
    let measured = memory.measured_reading().unwrap_or(recent);
    if fits(&measured) {
        return None;
    }
    Some(refusal(answer_bytes, &measured, reserved_bytes))
}
