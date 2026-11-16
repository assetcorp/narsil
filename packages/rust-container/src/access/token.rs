use std::collections::BTreeSet;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use narsil::{Map, Value, parse_plain_json};
use sha2::Sha256;

use super::constants::{
    MAX_TOKEN_BYTES, MAX_TOKEN_INDEXES, NOT_BEFORE_LEEWAY_SECONDS, SECONDS_TO_MS, SHA256_BYTES,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Admin,
    Read,
}

pub struct VerifiedToken {
    pub role: Role,
    pub expires_at_seconds: f64,
    pub indexes: Option<BTreeSet<String>>,
    pub subject: Option<String>,
    pub group: Option<String>,
}

pub struct SigningKeys {
    pub admin: Option<Vec<u8>>,
    pub read: Option<Vec<u8>>,
}

pub fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

fn decode_segment(segment: &str) -> Option<Vec<u8>> {
    let alphabet = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-';
    if segment.is_empty() || !segment.bytes().all(alphabet) {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(segment).ok()?;
    (URL_SAFE_NO_PAD.encode(&bytes) == segment).then_some(bytes)
}

fn parse_object(bytes: &[u8]) -> Option<Map> {
    match parse_plain_json(&String::from_utf8_lossy(bytes)) {
        Ok(Value::Object(fields)) => Some(fields),
        _ => None,
    }
}

fn signature_matches(key: Option<&[u8]>, signing_input: &str, signature: &[u8]) -> bool {
    let Some(key) = key else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(key) else {
        return false;
    };
    mac.update(signing_input.as_bytes());
    constant_time_equal(&mac.finalize().into_bytes(), signature)
}

fn role_of(keys: &SigningKeys, signing_input: &str, signature: &[u8]) -> Option<Role> {
    let admin = signature_matches(keys.admin.as_deref(), signing_input, signature);
    let read = signature_matches(keys.read.as_deref(), signing_input, signature);
    if admin {
        return Some(Role::Admin);
    }
    read.then_some(Role::Read)
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) if number.is_finite() => Some(*number),
        _ => None,
    }
}

fn optional_text(value: Option<&Value>) -> Result<Option<String>, ()> {
    match value {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(()),
    }
}

fn indexes_of(value: Option<&Value>) -> Result<Option<BTreeSet<String>>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Value::Array(items) = value else {
        return Err(());
    };
    if items.len() > MAX_TOKEN_INDEXES {
        return Err(());
    }
    let names = items
        .iter()
        .map(|item| item.as_str().map(str::to_string).ok_or(()))
        .collect::<Result<BTreeSet<String>, ()>>()?;
    Ok(Some(names))
}

fn usable_header(bytes: &[u8]) -> bool {
    parse_object(bytes).is_some_and(|header| {
        header.get("alg").and_then(Value::as_str) == Some("HS256") && !header.contains_key("crit")
    })
}

pub fn verify_token(token: &str, keys: &SigningKeys, now_ms: f64) -> Option<VerifiedToken> {
    if token.encode_utf16().count() > MAX_TOKEN_BYTES {
        return None;
    }
    let segments: Vec<&str> = token.split('.').collect();
    let [encoded_header, encoded_payload, encoded_signature] = segments.as_slice() else {
        return None;
    };
    let header = decode_segment(encoded_header)?;
    let payload = decode_segment(encoded_payload)?;
    let signature = decode_segment(encoded_signature)?;
    if signature.len() != SHA256_BYTES || !usable_header(&header) {
        return None;
    }
    let role = role_of(
        keys,
        &format!("{encoded_header}.{encoded_payload}"),
        &signature,
    )?;
    let payload = parse_object(&payload)?;
    let now_seconds = now_ms / SECONDS_TO_MS;
    let expires_at_seconds = finite_number(payload.get("exp"))?;
    if !(expires_at_seconds * SECONDS_TO_MS).is_finite() || expires_at_seconds <= now_seconds {
        return None;
    }
    if let Some(not_before) = payload.get("nbf") {
        let not_before = finite_number(Some(not_before))?;
        if not_before > now_seconds + NOT_BEFORE_LEEWAY_SECONDS {
            return None;
        }
    }
    let indexes = indexes_of(payload.get("indexes")).ok()?;
    let subject = optional_text(payload.get("sub")).ok()?;
    let group = optional_text(payload.get("group")).ok()?;
    Some(VerifiedToken {
        role,
        expires_at_seconds,
        indexes,
        subject,
        group,
    })
}
