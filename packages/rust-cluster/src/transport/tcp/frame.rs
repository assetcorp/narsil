use bytes::{Bytes, BytesMut};
use narsil::Value;
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::constants::{FRAME_READ_CHUNK_BYTES, LENGTH_PREFIX_BYTES, MAX_MESSAGE_SIZE_BYTES};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, encode_message_into, encoded_message_len};
use crate::wire::{self, Reader};
use crate::wire_size;

pub(crate) const FRAME_TYPE_REQUEST: u64 = 0x01;
pub(crate) const FRAME_TYPE_RESPONSE: u64 = 0x02;
pub(crate) const FRAME_TYPE_STREAM_CHUNK: u64 = 0x03;
pub(crate) const FRAME_TYPE_STREAM_END: u64 = 0x04;

pub(crate) struct Frame {
    pub(crate) frame_type: u64,
    pub(crate) request_id: String,
    pub(crate) data: Bytes,
}

pub(crate) enum FrameData<'a> {
    Message(&'a TransportMessage),
    Bytes(&'a [u8]),
}

impl FrameData<'_> {
    fn len(&self) -> usize {
        match self {
            FrameData::Message(message) => encoded_message_len(message),
            FrameData::Bytes(bytes) => bytes.len(),
        }
    }
}

fn too_large(bytes: usize) -> ClusterError {
    ClusterError::new(
        codes::TRANSPORT_MESSAGE_TOO_LARGE,
        format!("Encoded frame ({bytes} bytes) exceeds the {MAX_MESSAGE_SIZE_BYTES} byte limit"),
    )
    .with_detail("payloadSize", Value::Number(bytes as f64))
}

pub(crate) fn encode_frame(
    frame_type: u64,
    request_id: &str,
    data: FrameData<'_>,
) -> ClusterResult<Vec<u8>> {
    let data_len = data.len();
    let frame_len = wire_size::FIXMAP_HEADER_BYTES
        + wire_size::str_len("frameType".len())
        + wire_size::uint_len(frame_type)
        + wire_size::str_len("requestId".len())
        + wire_size::str_len(request_id.len())
        + wire_size::str_len("data".len())
        + wire_size::bin_len(data_len);
    if frame_len > MAX_MESSAGE_SIZE_BYTES {
        return Err(too_large(frame_len));
    }
    let mut out = Vec::with_capacity(LENGTH_PREFIX_BYTES + frame_len);
    out.extend_from_slice(&(frame_len as u32).to_be_bytes());
    wire::write_map_header(&mut out, 3);
    wire::write_str(&mut out, "frameType");
    wire::write_uint(&mut out, frame_type);
    wire::write_str(&mut out, "requestId");
    wire::write_str(&mut out, request_id);
    wire::write_str(&mut out, "data");
    match data {
        FrameData::Message(message) => {
            wire::write_bin_header(&mut out, data_len);
            encode_message_into(&mut out, message);
        }
        FrameData::Bytes(bytes) => wire::write_bin(&mut out, bytes),
    }
    Ok(out)
}

pub(crate) enum FrameReadError {
    Closed,
    TooLarge,
    Undecodable,
}

pub(crate) async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Frame, FrameReadError> {
    let mut prefix = [0u8; LENGTH_PREFIX_BYTES];
    reader
        .read_exact(&mut prefix)
        .await
        .map_err(|_| FrameReadError::Closed)?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length > MAX_MESSAGE_SIZE_BYTES {
        return Err(FrameReadError::TooLarge);
    }
    let mut buffer = BytesMut::with_capacity(length.min(FRAME_READ_CHUNK_BYTES));
    while buffer.len() < length {
        if buffer.capacity() == buffer.len() {
            buffer.reserve((length - buffer.len()).min(FRAME_READ_CHUNK_BYTES));
        }
        let wanted = length - buffer.len();
        let read = (&mut *reader)
            .take(wanted as u64)
            .read_buf(&mut buffer)
            .await
            .map_err(|_| FrameReadError::Closed)?;
        if read == 0 {
            return Err(FrameReadError::Closed);
        }
    }
    decode_frame(buffer.freeze()).ok_or(FrameReadError::Undecodable)
}

fn decode_frame(bytes: Bytes) -> Option<Frame> {
    let mut reader = Reader::new(&bytes);
    let length = reader.read_map_length().ok()?;
    let mut frame_type = None;
    let mut request_id = None;
    let mut data = None;
    for _ in 0..length {
        match reader.read_str().ok()? {
            "frameType" => frame_type = Some(reader.read_uint().ok()?),
            "requestId" => request_id = Some(reader.read_str().ok()?.to_string()),
            "data" => data = Some(reader.read_bin().ok()?),
            _ => reader.skip().ok()?,
        }
    }
    if !reader.is_finished() {
        return None;
    }
    let data = bytes.slice(data?);
    Some(Frame {
        frame_type: frame_type?,
        request_id: request_id?,
        data,
    })
}
