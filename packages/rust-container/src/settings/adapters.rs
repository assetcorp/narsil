use std::collections::BTreeSet;

use http::HeaderValue;

use super::constants::{
    DEFAULT_ADAPTER_MAX_RETRIES, DEFAULT_ADAPTER_TIMEOUT_MS,
    DEFAULT_RERANKER_MAX_DOCUMENTS_PER_REQUEST, MAX_ADAPTER_NAME_BYTES,
};
use super::types::{EmbedderSetting, RemoteEndpoint, RerankerSetting};
use super::urls::parse_http_url;
use super::variables::{Setting, SettingError, VariableReader, WholeNumberRange};

const TRANSFORMERS_KIND: &str = "transformers";

struct NamedAdapter {
    name: String,
    infix: String,
}

fn is_adapter_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    let Some(first) = bytes.first() else {
        return false;
    };
    let lower_or_digit = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    bytes.len() <= MAX_ADAPTER_NAME_BYTES
        && lower_or_digit(first)
        && bytes[1..]
            .iter()
            .all(|byte| lower_or_digit(byte) || *byte == b'_' || *byte == b'-')
}

fn names_of(reader: &VariableReader<'_>, list_variable: &str) -> Setting<Vec<NamedAdapter>> {
    let names = reader.list(list_variable)?.unwrap_or_default();
    let mut infixes = BTreeSet::new();
    let mut named = Vec::new();
    for name in names {
        if !is_adapter_name(&name) {
            return Err(SettingError::new(
                list_variable,
                "must hold names that match [a-z0-9][a-z0-9_-]{0,63}",
            ));
        }
        let infix = name.to_ascii_uppercase().replace('-', "_");
        if !infixes.insert(infix.clone()) {
            return Err(SettingError::new(
                list_variable,
                format!("must hold no two names with the same infix, as {infix} shows"),
            ));
        }
        named.push(NamedAdapter { name, infix });
    }
    Ok(named)
}

fn http_url(reader: &VariableReader<'_>, variable: &str) -> Setting<Option<String>> {
    let Some(raw) = reader.text(variable)? else {
        return Ok(None);
    };
    let Some(url) = parse_http_url(&raw) else {
        return Err(SettingError::new(
            variable,
            "must be an absolute http or https URL",
        ));
    };
    if url.has_user_info || url.has_query || url.has_fragment {
        return Err(SettingError::new(
            variable,
            "must be a base URL without credentials, a query, or a fragment",
        ));
    }
    Ok(Some(url.without_fragment()))
}

fn non_blank_text(reader: &VariableReader<'_>, variable: &str) -> Setting<Option<String>> {
    let value = reader.text(variable)?;
    if value.as_deref().is_some_and(|text| text.trim().is_empty()) {
        return Err(SettingError::new(
            variable,
            "must contain non-space characters",
        ));
    }
    Ok(value)
}

fn api_key_of(reader: &VariableReader<'_>, variable: &str) -> Setting<Option<String>> {
    let Some(key) = non_blank_text(reader, variable)? else {
        return Ok(None);
    };
    if HeaderValue::from_str(&format!("Bearer {key}")).is_err() {
        return Err(SettingError::new(
            variable,
            "must be a valid HTTP header value",
        ));
    }
    Ok(Some(key))
}

fn required<T>(value: Option<T>, variable: &str, rule: &str) -> Setting<T> {
    value.ok_or_else(|| SettingError::new(variable, rule))
}

fn at_least(min: u64) -> WholeNumberRange {
    WholeNumberRange { min, max: None }
}

struct RemoteFields {
    url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
}

fn read_remote_fields(reader: &VariableReader<'_>, prefix: &str) -> Setting<RemoteFields> {
    Ok(RemoteFields {
        url: http_url(reader, &format!("{prefix}URL"))?,
        api_key: api_key_of(reader, &format!("{prefix}API_KEY"))?,
        model: non_blank_text(reader, &format!("{prefix}MODEL"))?,
    })
}

fn timing(reader: &VariableReader<'_>, prefix: &str) -> Setting<(u64, u64)> {
    let timeout_ms = reader
        .whole_number(&format!("{prefix}TIMEOUT_MS"), at_least(1))?
        .unwrap_or(DEFAULT_ADAPTER_TIMEOUT_MS);
    let max_retries = reader
        .whole_number(&format!("{prefix}MAX_RETRIES"), at_least(0))?
        .unwrap_or(DEFAULT_ADAPTER_MAX_RETRIES);
    Ok((timeout_ms, max_retries))
}

fn remote_endpoint(
    fields: RemoteFields,
    prefix: &str,
    kind: &str,
    (timeout_ms, max_retries): (u64, u64),
) -> Setting<RemoteEndpoint> {
    let rule = format!("must be set for the {kind} kind");
    Ok(RemoteEndpoint {
        url: required(fields.url, &format!("{prefix}URL"), &rule)?,
        api_key: fields.api_key,
        model: required(fields.model, &format!("{prefix}MODEL"), &rule)?,
        timeout_ms,
        max_retries,
    })
}

fn refuse_transformers(prefix: &str, remote_kind: &str) -> SettingError {
    SettingError::new(
        &format!("{prefix}KIND"),
        format!("must be {remote_kind}, because this image leaves out the transformers kind"),
    )
}

fn read_embedder(reader: &VariableReader<'_>, adapter: NamedAdapter) -> Setting<EmbedderSetting> {
    let prefix = format!("NARSIL_EMBEDDER_{}_", adapter.infix);
    let kind_variable = format!("{prefix}KIND");
    let kind = required(
        reader.one_of(&kind_variable, &["openai", TRANSFORMERS_KIND])?,
        &kind_variable,
        "must be set to openai or transformers",
    )?;
    let fields = read_remote_fields(reader, &prefix)?;
    let dimensions_variable = format!("{prefix}DIMENSIONS");
    let dimensions = required(
        reader.whole_number(&dimensions_variable, at_least(1))?,
        &dimensions_variable,
        "must be set to a whole number of at least 1",
    )?;
    let timing = timing(reader, &prefix)?;
    if kind == TRANSFORMERS_KIND {
        return Err(refuse_transformers(&prefix, "openai"));
    }
    Ok(EmbedderSetting {
        name: adapter.name,
        endpoint: remote_endpoint(fields, &prefix, "openai", timing)?,
        dimensions,
    })
}

fn read_reranker(reader: &VariableReader<'_>, adapter: NamedAdapter) -> Setting<RerankerSetting> {
    let prefix = format!("NARSIL_RERANKER_{}_", adapter.infix);
    let kind_variable = format!("{prefix}KIND");
    let kind = required(
        reader.one_of(&kind_variable, &["http", TRANSFORMERS_KIND])?,
        &kind_variable,
        "must be set to http or transformers",
    )?;
    let fields = read_remote_fields(reader, &prefix)?;
    let timing = timing(reader, &prefix)?;
    let max_documents_per_request = reader
        .whole_number(&format!("{prefix}MAX_DOCUMENTS_PER_REQUEST"), at_least(1))?
        .unwrap_or(DEFAULT_RERANKER_MAX_DOCUMENTS_PER_REQUEST);
    if kind == TRANSFORMERS_KIND {
        return Err(refuse_transformers(&prefix, "http"));
    }
    Ok(RerankerSetting {
        name: adapter.name,
        endpoint: remote_endpoint(fields, &prefix, "http", timing)?,
        max_documents_per_request,
    })
}

pub fn read_embedders(reader: &VariableReader<'_>) -> Setting<Vec<EmbedderSetting>> {
    names_of(reader, "NARSIL_EMBEDDERS")?
        .into_iter()
        .map(|adapter| read_embedder(reader, adapter))
        .collect()
}

pub fn read_rerankers(reader: &VariableReader<'_>) -> Setting<Vec<RerankerSetting>> {
    names_of(reader, "NARSIL_RERANKERS")?
        .into_iter()
        .map(|adapter| read_reranker(reader, adapter))
        .collect()
}
