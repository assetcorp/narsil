use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{Compression, Expectation, open_checksummed, pack};
use crate::value::{Map, Value, decode_value, encode_value};

const INDEX_CONFIGURATION_ENVELOPE_VERSION: u8 = 5;
pub(crate) const MAX_INDEX_CONFIGURATION_BYTES: usize = 16_777_216;

/// Checks that a decoded index configuration holds a schema and a language, as every reader of one must.
pub(crate) fn require_configuration_shape(raw: &Value, what: &str) -> Result<Map> {
    let Value::Object(configuration) = raw else {
        return Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!("The {what} does not hold an index configuration"),
        ));
    };
    if !matches!(
        configuration.get("schema"),
        Some(Value::Object(_) | Value::Array(_) | Value::Bytes(_) | Value::Timestamp(_))
    ) {
        return Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!("The {what} holds no schema"),
        ));
    }
    if !matches!(configuration.get("language"), Some(Value::String(language)) if !language.is_empty())
    {
        return Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!("The {what} holds no language"),
        ));
    }
    Ok(configuration.clone())
}

pub(crate) fn decode_index_configuration(bytes: &[u8]) -> Result<(Compression, Map)> {
    let expected = Expectation {
        version: INDEX_CONFIGURATION_ENVELOPE_VERSION,
        what: "index configuration",
        allows_compression: true,
    };
    let (header, payload) = open_checksummed(bytes, &expected)?;
    let raw = decode_value(payload.bytes()).map_err(|_| {
        NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            "The index configuration is not MessagePack",
        )
    })?;
    Ok((
        header.compression(),
        require_configuration_shape(&raw, "index configuration")?,
    ))
}

pub(crate) fn encode_index_configuration(
    configuration: &Map,
    compression: Compression,
) -> Result<Vec<u8>> {
    let payload = encode_value(&Value::Object(configuration.clone()))?;
    pack(
        &payload,
        INDEX_CONFIGURATION_ENVELOPE_VERSION,
        compression,
        "index configuration",
    )
}
