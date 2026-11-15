use bytes::Bytes;
use narsil::{Map, Value, write_plain_json_into};
use tokio::sync::mpsc;

use super::constants::{RESPONSE_GROUP_DOCUMENTS, RESPONSE_STREAM_CHANNEL_CHUNKS};
use crate::constants::{JSON_CONTENT_TYPE, RESPONSE_STREAM_CHUNK_BYTES};
use crate::http::respond::{HttpResponse, json, stream};

pub(crate) struct Answer {
    pub(crate) key: &'static str,
    pub(crate) items: Vec<Value>,
    pub(crate) rest: Map,
}

impl Answer {
    fn whole(self) -> Value {
        let mut body = Map::with_capacity(self.rest.len() + 1);
        body.insert(self.key, Value::Array(self.items));
        for (key, value) in self.rest.iter() {
            body.insert(key.clone(), value.clone());
        }
        Value::Object(body)
    }
}

fn opening(key: &str) -> String {
    let mut text = String::from("{");
    write_plain_json_into(&mut text, &Value::String(key.to_string()));
    text.push_str(":[");
    text
}

fn closing(rest: &Map) -> String {
    let mut text = String::from("]");
    for (key, value) in rest.iter() {
        text.push(',');
        write_plain_json_into(&mut text, &Value::String(key.clone()));
        text.push(':');
        write_plain_json_into(&mut text, value);
    }
    text.push('}');
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
    buffer.push_str(&closing(&answer.rest));
    let _ = sender.send(Ok(Bytes::from(buffer))).await;
}

pub(crate) fn respond_answer(answer: Answer) -> HttpResponse {
    if answer.items.len() <= RESPONSE_GROUP_DOCUMENTS {
        return json(200, &answer.whole());
    }
    let (sender, receiver) = mpsc::channel(RESPONSE_STREAM_CHANNEL_CHUNKS);
    tokio::spawn(send_chunks(answer, sender));
    stream(200, JSON_CONTENT_TYPE, receiver)
}
