use std::time::Duration;

use bytes::Bytes;
use http::header::{AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use http::{HeaderMap, HeaderName, HeaderValue};
use narsil::{ErrorCode, Map, NarsilError, Value, parse_plain_json};

use super::constants::{
    BASE_BACKOFF_MS, MAX_BACKOFF_MS, MAX_ERROR_ANSWER_BYTES, MAX_JITTER_MS, RETRYABLE_STATUS_CODES,
};
use crate::outbound::OutboundClient;

pub struct RetryingPost<'a> {
    pub client: &'a OutboundClient,
    pub url: &'a str,
    pub body: String,
    pub api_key: Option<&'a str>,
    pub max_retries: u64,
    pub service: &'a str,
    pub failure_code: ErrorCode,
    pub max_answer_bytes: usize,
}

fn random_fraction() -> f64 {
    let mut bytes = [0u8; 4];
    if getrandom::fill(&mut bytes).is_err() {
        return 0.5;
    }
    f64::from(u32::from_le_bytes(bytes)) / f64::from(u32::MAX)
}

fn backoff(attempt: u64, retry_after_seconds: Option<f64>) -> Duration {
    if let Some(seconds) = retry_after_seconds {
        return Duration::from_millis((seconds * 1_000.0).min(MAX_BACKOFF_MS as f64) as u64);
    }
    let exponent = u32::try_from(attempt).unwrap_or(u32::MAX).min(32);
    let exponential = BASE_BACKOFF_MS
        .saturating_mul(1u64 << exponent)
        .min(MAX_BACKOFF_MS);
    Duration::from_millis(exponential + (random_fraction() * MAX_JITTER_MS as f64) as u64)
}

fn retry_after(headers: &HeaderMap) -> Option<f64> {
    let seconds = headers
        .get(RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()?;
    (seconds.is_finite() && seconds > 0.0).then_some(seconds)
}

fn text_field(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn error_info(status: u16, body: Option<&Bytes>) -> (String, String) {
    let fallback = format!("HTTP {status}");
    let parsed = body
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .and_then(|text| parse_plain_json(text).ok());
    let Some(Value::Object(fields)) = parsed else {
        return ("unknown".to_string(), fallback);
    };
    let nested = fields.get("error").and_then(Value::as_object);
    let error_type = text_field(nested.and_then(|error| error.get("type")))
        .unwrap_or_else(|| "unknown".to_string());
    let message = text_field(nested.and_then(|error| error.get("message")))
        .or_else(|| text_field(fields.get("error")))
        .or_else(|| text_field(fields.get("message")))
        .or_else(|| text_field(fields.get("detail")))
        .unwrap_or(fallback);
    (error_type, message)
}

fn failure(code: ErrorCode, message: String) -> NarsilError {
    NarsilError::new(code, message)
}

fn headers_of(api_key: Option<&str>) -> Result<Vec<(HeaderName, HeaderValue)>, String> {
    let mut headers = vec![(CONTENT_TYPE, HeaderValue::from_static("application/json"))];
    if let Some(key) = api_key {
        let mut value = HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| "The API key is not a valid header value".to_string())?;
        value.set_sensitive(true);
        headers.push((AUTHORIZATION, value));
    }
    Ok(headers)
}

pub async fn post_json_with_retry(request: RetryingPost<'_>) -> Result<Map, NarsilError> {
    let code = request.failure_code;
    let service = request.service;
    let headers = headers_of(request.api_key).map_err(|message| failure(code, message))?;
    let body = Bytes::from(request.body);
    let attempts = request.max_retries.saturating_add(1);
    let mut attempt = 0u64;
    loop {
        let last = attempt + 1 >= attempts;
        let answer = request
            .client
            .post(
                request.url,
                headers.clone(),
                body.clone(),
                request.max_answer_bytes,
            )
            .await;
        let answer = match answer {
            Ok(answer) => answer,
            Err(cause) => {
                if last {
                    return Err(failure(
                        code,
                        format!(
                            "{service} request failed after {attempts} attempts: network error"
                        ),
                    )
                    .with_details([("cause", Value::String(cause.to_string()))]));
                }
                tokio::time::sleep(backoff(attempt, None)).await;
                attempt += 1;
                continue;
            }
        };
        if (200..300).contains(&answer.status) {
            let parsed = answer
                .body
                .as_ref()
                .and_then(|bytes| std::str::from_utf8(bytes).ok())
                .and_then(|text| parse_plain_json(text).ok());
            match parsed {
                Some(Value::Object(fields)) => return Ok(fields),
                Some(_) => {
                    return Err(failure(
                        code,
                        format!("{service} returned non-object JSON response"),
                    ));
                }
                None if last => {
                    return Err(failure(
                        code,
                        format!("{service} returned invalid JSON in response body"),
                    ));
                }
                None => {
                    tokio::time::sleep(backoff(attempt, None)).await;
                    attempt += 1;
                    continue;
                }
            }
        }
        let error_body = answer
            .body
            .filter(|bytes| bytes.len() <= MAX_ERROR_ANSWER_BYTES);
        let (error_type, message) = error_info(answer.status, error_body.as_ref());
        if !RETRYABLE_STATUS_CODES.contains(&answer.status) || last {
            return Err(failure(
                code,
                format!(
                    "{service} API error ({}): [{error_type}] {message}",
                    answer.status
                ),
            )
            .with_details([
                ("status", Value::Number(f64::from(answer.status))),
                ("errorType", Value::String(error_type)),
            ]));
        }
        tokio::time::sleep(backoff(attempt, retry_after(&answer.headers))).await;
        attempt += 1;
    }
}
