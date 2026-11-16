use bytes::Bytes;
use narsil::{Map, Value, write_plain_json_into};
use tokio::sync::mpsc;

use super::constants::RESPONSE_STREAM_CHANNEL_CHUNKS;
use crate::constants::RESPONSE_GROUP_DOCUMENTS;
use crate::constants::{JSON_CONTENT_TYPE, RESPONSE_STREAM_CHUNK_BYTES};
use crate::http::respond::{HttpResponse, json_text, stream};

pub(crate) struct Answer {
    pub(crate) key: &'static str,
    pub(crate) items: Vec<Value>,
    pub(crate) rest: Map,
}

pub(crate) enum Reply {
    Ready(HttpResponse),
    Streamed(Answer),
}

impl Reply {
    pub(crate) fn into_response(self) -> HttpResponse {
        match self {
            Reply::Ready(response) => response,
            Reply::Streamed(answer) => {
                let (sender, receiver) = mpsc::channel(RESPONSE_STREAM_CHANNEL_CHUNKS);
                tokio::spawn(send_chunks(answer, sender));
                stream(200, JSON_CONTENT_TYPE, receiver)
            }
        }
    }
}

fn opening(key: &str) -> String {
    let mut text = String::from("{");
    write_plain_json_into(&mut text, &Value::String(key.to_string()));
    text.push_str(":[");
    text
}

fn close_into(text: &mut String, rest: &Map) {
    text.push(']');
    for (key, value) in rest.iter() {
        text.push(',');
        write_plain_json_into(text, &Value::String(key.clone()));
        text.push(':');
        write_plain_json_into(text, value);
    }
    text.push('}');
}

fn written(answer: Answer) -> String {
    let mut text = opening(answer.key);
    for (at, item) in answer.items.iter().enumerate() {
        if at > 0 {
            text.push(',');
        }
        write_plain_json_into(&mut text, item);
    }
    close_into(&mut text, &answer.rest);
    text
}

async fn send_chunks(answer: Answer, sender: mpsc::Sender<std::io::Result<Bytes>>) {
    let mut buffer = opening(answer.key);
    for (at, item) in answer.items.into_iter().enumerate() {
        if at > 0 {
            buffer.push(',');
        }
        write_plain_json_into(&mut buffer, &item);
        if buffer.len() >= RESPONSE_STREAM_CHUNK_BYTES {
            let chunk = Bytes::from(std::mem::take(&mut buffer));
            if sender.send(Ok(chunk)).await.is_err() {
                return;
            }
        }
    }
    close_into(&mut buffer, &answer.rest);
    let _ = sender.send(Ok(Bytes::from(buffer))).await;
}

pub(crate) fn answer_reply(answer: Answer) -> Reply {
    if answer.items.len() <= RESPONSE_GROUP_DOCUMENTS {
        return Reply::Ready(json_text(200, written(answer)));
    }
    Reply::Streamed(answer)
}
