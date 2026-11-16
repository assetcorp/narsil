use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use hmac::{Hmac, KeyInit, Mac};
use http::header::{CONTENT_TYPE, USER_AGENT};
use http::{HeaderName, HeaderValue};
use sha2::Sha256;

use super::constants::{
    GONE_STATUS, SEND_TIMEOUT_MS, WEBHOOK_ANSWER_BYTES_READ, WEBHOOK_USER_AGENT,
};
use super::delivery::Delivery;
use crate::events::body::now_ms;
use crate::outbound::OutboundClient;

const MS_PER_SECOND: u64 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendOutcome {
    Delivered,
    Gone,
    Failed,
}

pub struct Destination {
    pub client: OutboundClient,
    pub url: String,
    pub secret: Vec<u8>,
}

pub fn sign_delivery(
    secret: &[u8],
    id: &str,
    timestamp_seconds: u64,
    body: &str,
) -> Option<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).ok()?;
    mac.update(format!("{id}.{timestamp_seconds}.{body}").as_bytes());
    Some(format!(
        "v1,{}",
        STANDARD.encode(mac.finalize().into_bytes())
    ))
}

fn header(name: &'static str, value: &str) -> Option<(HeaderName, HeaderValue)> {
    Some((
        HeaderName::from_static(name),
        HeaderValue::from_str(value).ok()?,
    ))
}

fn headers_of(
    destination: &Destination,
    delivery: &Delivery,
) -> Option<Vec<(HeaderName, HeaderValue)>> {
    let timestamp = now_ms() / MS_PER_SECOND;
    let signature = sign_delivery(&destination.secret, &delivery.id, timestamp, &delivery.body)?;
    Some(vec![
        (CONTENT_TYPE, HeaderValue::from_static("application/json")),
        (USER_AGENT, HeaderValue::from_static(WEBHOOK_USER_AGENT)),
        header("webhook-id", &delivery.id)?,
        header("webhook-timestamp", &timestamp.to_string())?,
        header("webhook-signature", &signature)?,
    ])
}

pub async fn send(destination: &Destination, delivery: &Delivery) -> SendOutcome {
    let Some(headers) = headers_of(destination, delivery) else {
        return SendOutcome::Failed;
    };
    let body = Bytes::from(delivery.body.clone());
    let sent = tokio::time::timeout(
        Duration::from_millis(SEND_TIMEOUT_MS),
        destination
            .client
            .post(&destination.url, headers, body, WEBHOOK_ANSWER_BYTES_READ),
    )
    .await;
    match sent {
        Ok(Ok(answer)) if (200..300).contains(&answer.status) => SendOutcome::Delivered,
        Ok(Ok(answer)) if answer.status == GONE_STATUS => SendOutcome::Gone,
        _ => SendOutcome::Failed,
    }
}
