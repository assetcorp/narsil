#![allow(dead_code)]

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub const NODE_ID: &str = "rust-node";
pub const PING_TIMESTAMP: u64 = 1_700_000_000_000;
pub const REPLY_WAIT: Duration = Duration::from_secs(5);
pub const MAX_MESSAGE_SIZE_BYTES: usize = 64 * 1024 * 1024;
pub const FRAME_REQUEST: u64 = 1;
pub const FRAME_RESPONSE: u64 = 2;
pub const FRAME_STREAM_CHUNK: u64 = 3;
pub const FRAME_STREAM_END: u64 = 4;

#[derive(Debug, Clone, PartialEq)]
pub enum Decoded {
    Nil,
    Bool(bool),
    Unsigned(u64),
    Signed(i64),
    Float(f64),
    Text(String),
    Binary(Vec<u8>),
    List(Vec<Decoded>),
    Fields(Vec<(String, Decoded)>),
}

impl Decoded {
    pub fn field(&self, name: &str) -> Option<&Decoded> {
        match self {
            Decoded::Fields(fields) => fields
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn keys(&self) -> Vec<&str> {
        match self {
            Decoded::Fields(fields) => fields.iter().map(|(key, _)| key.as_str()).collect(),
            _ => Vec::new(),
        }
    }

    pub fn text(&self, name: &str) -> String {
        match self.field(name) {
            Some(Decoded::Text(text)) => text.clone(),
            other => panic!("{name} holds {other:?}, which is not text"),
        }
    }

    pub fn bytes(&self, name: &str) -> Vec<u8> {
        match self.field(name) {
            Some(Decoded::Binary(bytes)) => bytes.clone(),
            other => panic!("{name} holds {other:?}, which is not binary"),
        }
    }

    pub fn unsigned(&self, name: &str) -> u64 {
        match self.field(name) {
            Some(Decoded::Unsigned(number)) => *number,
            other => panic!("{name} holds {other:?}, which is not an unsigned integer"),
        }
    }
}

pub fn decode(bytes: &[u8]) -> Decoded {
    let mut at = 0;
    let value = decode_at(bytes, &mut at);
    assert_eq!(at, bytes.len(), "bytes follow the MessagePack value");
    value
}

fn take<'a>(bytes: &'a [u8], at: &mut usize, count: usize) -> &'a [u8] {
    let slice = &bytes[*at..*at + count];
    *at += count;
    slice
}

fn big_endian(bytes: &[u8], at: &mut usize, count: usize) -> u64 {
    take(bytes, at, count)
        .iter()
        .fold(0, |sum, byte| (sum << 8) | u64::from(*byte))
}

fn text_of(bytes: &[u8], at: &mut usize, count: usize) -> Decoded {
    Decoded::Text(
        String::from_utf8(take(bytes, at, count).to_vec())
            .expect("a MessagePack string holds UTF-8"),
    )
}

fn list_of(bytes: &[u8], at: &mut usize, count: usize) -> Decoded {
    Decoded::List((0..count).map(|_| decode_at(bytes, at)).collect())
}

fn fields_of(bytes: &[u8], at: &mut usize, count: usize) -> Decoded {
    let mut fields = Vec::with_capacity(count);
    for _ in 0..count {
        let Decoded::Text(key) = decode_at(bytes, at) else {
            panic!("a map key is not a string");
        };
        fields.push((key, decode_at(bytes, at)));
    }
    Decoded::Fields(fields)
}

fn decode_at(bytes: &[u8], at: &mut usize) -> Decoded {
    let marker = take(bytes, at, 1)[0];
    match marker {
        0x00..=0x7f => Decoded::Unsigned(u64::from(marker)),
        0x80..=0x8f => fields_of(bytes, at, usize::from(marker & 0x0f)),
        0x90..=0x9f => list_of(bytes, at, usize::from(marker & 0x0f)),
        0xa0..=0xbf => text_of(bytes, at, usize::from(marker & 0x1f)),
        0xc0 => Decoded::Nil,
        0xc2 => Decoded::Bool(false),
        0xc3 => Decoded::Bool(true),
        0xc4..=0xc6 => {
            let width = 1 << (marker - 0xc4);
            let count = big_endian(bytes, at, width) as usize;
            Decoded::Binary(take(bytes, at, count).to_vec())
        }
        0xca => Decoded::Float(f64::from(f32::from_bits(big_endian(bytes, at, 4) as u32))),
        0xcb => Decoded::Float(f64::from_bits(big_endian(bytes, at, 8))),
        0xcc..=0xcf => Decoded::Unsigned(big_endian(bytes, at, 1 << (marker - 0xcc))),
        0xd0..=0xd3 => {
            let width = 1 << (marker - 0xd0);
            let raw = big_endian(bytes, at, width);
            let shift = 64 - 8 * width as u32;
            Decoded::Signed(((raw << shift) as i64) >> shift)
        }
        0xd9..=0xdb => {
            let count = big_endian(bytes, at, 1 << (marker - 0xd9)) as usize;
            text_of(bytes, at, count)
        }
        0xdc | 0xdd => {
            let count = big_endian(bytes, at, 2 << (marker - 0xdc)) as usize;
            list_of(bytes, at, count)
        }
        0xde | 0xdf => {
            let count = big_endian(bytes, at, 2 << (marker - 0xde)) as usize;
            fields_of(bytes, at, count)
        }
        0xe0..=0xff => Decoded::Signed(i64::from(marker as i8)),
        _ => panic!("the test decoder reads no MessagePack marker {marker:#04x}"),
    }
}

pub fn write_map_header(out: &mut Vec<u8>, count: usize) {
    assert!(count < 16);
    out.push(0x80 | count as u8);
}

pub fn write_text(out: &mut Vec<u8>, text: &str) {
    let length = text.len();
    if length < 32 {
        out.push(0xa0 | length as u8);
    } else if length < 256 {
        out.extend_from_slice(&[0xd9, length as u8]);
    } else {
        out.push(0xda);
        out.extend_from_slice(&(length as u16).to_be_bytes());
    }
    out.extend_from_slice(text.as_bytes());
}

pub fn write_binary(out: &mut Vec<u8>, bytes: &[u8]) {
    let length = bytes.len();
    if length < 256 {
        out.extend_from_slice(&[0xc4, length as u8]);
    } else if length < 65_536 {
        out.push(0xc5);
        out.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        out.push(0xc6);
        out.extend_from_slice(&(length as u32).to_be_bytes());
    }
    out.extend_from_slice(bytes);
}

pub fn write_unsigned(out: &mut Vec<u8>, number: u64) {
    if number < 128 {
        out.push(number as u8);
    } else {
        out.push(0xcf);
        out.extend_from_slice(&number.to_be_bytes());
    }
}

pub fn ping_payload(timestamp: u64) -> Vec<u8> {
    let mut out = Vec::new();
    write_map_header(&mut out, 1);
    write_text(&mut out, "timestamp");
    write_unsigned(&mut out, timestamp);
    out
}

pub fn envelope(message_type: &str, request_id: &str, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    write_map_header(&mut out, 4);
    write_text(&mut out, "type");
    write_text(&mut out, message_type);
    write_text(&mut out, "sourceId");
    write_text(&mut out, "hostile-peer");
    write_text(&mut out, "requestId");
    write_text(&mut out, request_id);
    write_text(&mut out, "payload");
    write_binary(&mut out, payload);
    out
}

pub fn frame(frame_type: u64, request_id: &str, data: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    write_map_header(&mut body, 3);
    write_text(&mut body, "frameType");
    write_unsigned(&mut body, frame_type);
    write_text(&mut body, "requestId");
    write_text(&mut body, request_id);
    write_text(&mut body, "data");
    write_binary(&mut body, data);
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(&body);
    out
}

pub fn ping_frame(request_id: &str) -> Vec<u8> {
    frame(
        FRAME_REQUEST,
        request_id,
        &envelope("cluster.ping", request_id, &ping_payload(PING_TIMESTAMP)),
    )
}

pub async fn read_frame(stream: &mut TcpStream) -> Option<Decoded> {
    let read = async {
        let mut prefix = [0u8; 4];
        stream.read_exact(&mut prefix).await.ok()?;
        let mut body = vec![0u8; u32::from_be_bytes(prefix) as usize];
        stream.read_exact(&mut body).await.ok()?;
        Some(decode(&body))
    };
    tokio::time::timeout(REPLY_WAIT, read)
        .await
        .expect("the node neither answered nor closed the connection")
}

pub async fn closes(stream: &mut TcpStream) -> bool {
    let mut byte = [0u8; 1];
    match tokio::time::timeout(REPLY_WAIT, stream.read(&mut byte)).await {
        Ok(Ok(0)) | Ok(Err(_)) => true,
        Ok(Ok(_)) | Err(_) => false,
    }
}

pub fn assert_pong(envelope: &Decoded, request_id: &str) {
    assert_eq!(envelope.text("type"), "cluster.pong");
    assert_eq!(envelope.text("sourceId"), NODE_ID);
    assert_eq!(envelope.text("requestId"), request_id);
    let pong = decode(&envelope.bytes("payload"));
    assert_eq!(pong.keys(), ["timestamp", "respondedAt"]);
    assert_eq!(pong.unsigned("timestamp"), PING_TIMESTAMP);
}

pub async fn ping_over(stream: &mut TcpStream, request_id: &str) {
    stream
        .write_all(&ping_frame(request_id))
        .await
        .expect("the node accepts the ping");
    let reply = read_frame(stream).await.expect("the node answers the ping");
    assert_eq!(reply.unsigned("frameType"), FRAME_RESPONSE);
    assert_eq!(reply.text("requestId"), request_id);
    assert_pong(&decode(&reply.bytes("data")), request_id);
}
