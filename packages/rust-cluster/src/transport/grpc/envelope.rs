use std::time::Duration;

use bytes::Bytes;
use http::HeaderValue;
use prost::Message;
use tonic::{Code, Status};

use crate::constants::{GRPC_ENVELOPE_OVERHEAD_BYTES, MAX_MESSAGE_SIZE_BYTES};

pub(crate) const SEND_METHOD_PATH: &str = "/narsil.transport.v1.NodeTransport/Send";
pub(crate) const OPEN_STREAM_METHOD_PATH: &str = "/narsil.transport.v1.NodeTransport/OpenStream";

pub(crate) const MAX_GRPC_MESSAGE_BYTES: usize =
    MAX_MESSAGE_SIZE_BYTES + GRPC_ENVELOPE_OVERHEAD_BYTES;

const GRPC_STATUS_HEADER: &str = "grpc-status";

#[derive(Clone, PartialEq, Message)]
pub(crate) struct Envelope {
    #[prost(bytes = "bytes", tag = "1")]
    pub(crate) message: Bytes,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct Chunk {
    #[prost(bytes = "bytes", tag = "1")]
    pub(crate) data: Bytes,
}

pub(crate) fn too_large_status(bytes: usize) -> Status {
    Status::resource_exhausted(format!(
        "Sent message larger than max ({bytes} vs. {MAX_GRPC_MESSAGE_BYTES})"
    ))
}

pub(crate) fn within_limit<M: Message>(message: M) -> Result<M, Status> {
    let length = message.encoded_len();
    if length > MAX_GRPC_MESSAGE_BYTES {
        return Err(too_large_status(length));
    }
    Ok(message)
}

pub(crate) const GRPC_TIMEOUT_HEADER: &str = "grpc-timeout";
const GRPC_TIMEOUT_MOST_DIGITS: usize = 8;
const SECONDS_PER_HOUR: u64 = 3_600;
const SECONDS_PER_MINUTE: u64 = 60;

pub(crate) fn client_deadline(value: &[u8]) -> Option<Duration> {
    let (&unit, digits) = value.split_last()?;
    if digits.is_empty()
        || digits.len() > GRPC_TIMEOUT_MOST_DIGITS
        || !digits.iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let amount: u64 = std::str::from_utf8(digits).ok()?.parse().ok()?;
    match unit {
        b'H' => Some(Duration::from_secs(amount * SECONDS_PER_HOUR)),
        b'M' => Some(Duration::from_secs(amount * SECONDS_PER_MINUTE)),
        b'S' => Some(Duration::from_secs(amount)),
        b'm' => Some(Duration::from_millis(amount)),
        b'u' => Some(Duration::from_micros(amount)),
        b'n' => Some(Duration::from_nanos(amount)),
        _ => None,
    }
}

pub(crate) fn report_size_limit_as_resource_exhausted<B>(
    mut response: http::Response<B>,
) -> http::Response<B> {
    let out_of_range = (Code::OutOfRange as i32).to_string();
    let headers = response.headers_mut();
    if headers
        .get(GRPC_STATUS_HEADER)
        .is_some_and(|value| value.as_bytes() == out_of_range.as_bytes())
    {
        let resource_exhausted = (Code::ResourceExhausted as i32).to_string();
        if let Ok(value) = HeaderValue::from_str(&resource_exhausted) {
            headers.insert(GRPC_STATUS_HEADER, value);
        }
    }
    response
}
