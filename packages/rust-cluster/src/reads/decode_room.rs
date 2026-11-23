use super::ReadDeps;
use crate::constants::ANSWER_DECODE_HEAP_BYTES_PER_PAYLOAD_BYTE;
use crate::memory::answer_refusal_of;
use crate::query::failover::Failure;

pub(crate) fn refuse_decode_without_room(deps: &ReadDeps, payload: &[u8]) -> Result<(), Failure> {
    let Some(memory) = &deps.memory else {
        return Ok(());
    };
    let payload_bytes = u64::try_from(payload.len()).unwrap_or(u64::MAX);
    let answer_bytes = payload_bytes.saturating_mul(ANSWER_DECODE_HEAP_BYTES_PER_PAYLOAD_BYTE);
    let reserved_bytes = deps
        .local
        .as_ref()
        .map_or(0, |local| local.reserved_memory_bytes());
    match answer_refusal_of(memory, answer_bytes, reserved_bytes) {
        Some(refusal) => Err(Failure {
            error: refusal,
            node_rejection: true,
        }),
        None => Ok(()),
    }
}
