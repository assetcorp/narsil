pub(crate) mod ack;
pub(crate) mod client;
pub(crate) mod entry;
pub(crate) mod fields;
pub(crate) mod forward;
pub(crate) mod replica;
pub(crate) mod snapshot;
pub(crate) mod sync;
pub(crate) mod term_start;

use narsil::Value;

use crate::error::{ClusterError, ClusterResult, codes};
use crate::wire;
use fields::{Field, fields_of};

pub(crate) fn decodable(payload: &[u8], message_type: &str) -> ClusterResult<()> {
    wire::validate(payload).map_err(|_| {
        ClusterError::new(
            codes::TRANSPORT_DECODE_FAILED,
            format!("The payload of a {message_type} request is not valid MessagePack"),
        )
        .with_detail("messageType", Value::String(message_type.to_string()))
    })
}

pub(crate) fn invalid_entry(payload_name: &str, rule: &str) -> ClusterError {
    ClusterError::new(
        codes::REPLICATION_ENTRY_INVALID,
        format!("Invalid {payload_name}: {rule}"),
    )
}

pub(crate) fn members<'a, const N: usize>(
    value: &'a [u8],
    names: [&str; N],
    payload_name: &str,
) -> ClusterResult<[Field<'a>; N]> {
    fields_of(value, names).ok_or_else(|| invalid_entry(payload_name, "expected a map"))
}

pub(crate) fn index_uuid(field: Field<'_>, payload_name: &str) -> ClusterResult<Option<String>> {
    field
        .optional(|uuid| uuid.filled_text().map(str::to_string))
        .ok_or_else(|| {
            invalid_entry(
                payload_name,
                "\"indexUuid\" must be a non-empty string or absent",
            )
        })
}
