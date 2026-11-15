use std::collections::BTreeSet;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use super::constants::{MAX_WEBHOOK_SECRET_BYTES, MIN_WEBHOOK_SECRET_BYTES, WEBHOOK_SECRET_PREFIX};
use super::types::WebhookSettings;
use super::urls::parse_http_url;
use super::variables::{Setting, SettingError, VariableReader};
use crate::events::types::is_event_type;

const URL_VARIABLE: &str = "NARSIL_WEBHOOK_URL";
const SECRET_VARIABLE: &str = "NARSIL_WEBHOOK_SECRET";
const EVENTS_VARIABLE: &str = "NARSIL_WEBHOOK_EVENTS";

fn secret_rule() -> SettingError {
    SettingError::new(
        SECRET_VARIABLE,
        format!(
            "must be {WEBHOOK_SECRET_PREFIX} followed by the base64 of {MIN_WEBHOOK_SECRET_BYTES} to {MAX_WEBHOOK_SECRET_BYTES} bytes"
        ),
    )
}

fn is_standard_base64(encoded: &str) -> bool {
    let body = encoded.trim_end_matches('=');
    let padding = encoded.len() - body.len();
    !body.is_empty()
        && padding <= 2
        && encoded.len().is_multiple_of(4)
        && body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
}

fn decode_secret(raw: &str) -> Setting<Vec<u8>> {
    let encoded = raw
        .strip_prefix(WEBHOOK_SECRET_PREFIX)
        .ok_or_else(secret_rule)?;
    if !is_standard_base64(encoded) {
        return Err(secret_rule());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| secret_rule())?;
    if STANDARD.encode(&bytes) != encoded {
        return Err(secret_rule());
    }
    if !(MIN_WEBHOOK_SECRET_BYTES..=MAX_WEBHOOK_SECRET_BYTES).contains(&bytes.len()) {
        return Err(secret_rule());
    }
    Ok(bytes)
}

fn read_url(reader: &VariableReader<'_>) -> Setting<Option<String>> {
    let Some(raw) = reader.text(URL_VARIABLE)? else {
        return Ok(None);
    };
    let Some(url) = parse_http_url(&raw) else {
        return Err(SettingError::new(
            URL_VARIABLE,
            "must be an absolute http or https URL",
        ));
    };
    if url.has_user_info {
        return Err(SettingError::new(
            URL_VARIABLE,
            "must carry no user name or password",
        ));
    }
    Ok(Some(url.without_fragment()))
}

fn read_events(reader: &VariableReader<'_>) -> Setting<Option<BTreeSet<String>>> {
    let Some(events) = reader.list(EVENTS_VARIABLE)? else {
        return Ok(None);
    };
    if !events.iter().all(|event| is_event_type(event)) {
        return Err(SettingError::new(
            EVENTS_VARIABLE,
            "must hold event types such as engine.workerCrash or task.finished",
        ));
    }
    Ok(Some(events.into_iter().collect()))
}

pub fn read_webhook(
    reader: &VariableReader<'_>,
    warnings: &mut Vec<String>,
) -> Setting<Option<WebhookSettings>> {
    let url = read_url(reader)?;
    let secret = reader
        .text(SECRET_VARIABLE)?
        .map(|raw| decode_secret(&raw))
        .transpose()?;
    let events = read_events(reader)?;
    let Some(url) = url else {
        for variable in [SECRET_VARIABLE, EVENTS_VARIABLE] {
            if reader.is_set(variable)? {
                warnings.push(format!(
                    "{variable} takes effect only with {URL_VARIABLE}, which is unset"
                ));
            }
        }
        return Ok(None);
    };
    let Some(secret) = secret else {
        return Err(SettingError::new(
            SECRET_VARIABLE,
            format!("must be set with {URL_VARIABLE}"),
        ));
    };
    Ok(Some(WebhookSettings {
        url,
        secret,
        events,
    }))
}
