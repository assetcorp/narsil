mod analysis;
mod bm25;
mod partitions;
mod sync;
mod vectors;

use crate::error::{ErrorCode, NarsilError};
use crate::format::fields::non_negative_safe_integer;
use crate::value::Value;

pub(crate) use analysis::{
    NamedAnalysis, PendingAnalysis, named_analysis_to_wire, pending_from_wire,
};
pub(crate) use bm25::{
    Bm25Params, DEFAULT_BM25_B, DEFAULT_BM25_K1, FieldBm25, bm25_from_wire, bm25_to_wire,
};
pub(crate) use partitions::{PartitionLimits, limits_from_wire, limits_to_wire};
pub(crate) use sync::{SyncSetting, sync_from_wire, sync_to_wire};
pub(crate) use vectors::{
    EmbeddingMetadata, EmbeddingSource, HnswSettings, VectorFieldMetadata, VectorPromotion,
    embedding_from_wire, embedding_to_wire, promotion_from_wire, promotion_to_wire,
    vector_fields_from_wire, vector_fields_to_wire,
};

const QUANTIZATION_MODES: [&str; 5] = ["osq8", "osq4", "osq2", "osq1", "none"];
const STORAGE_MODES: [&str; 2] = ["memory", "disk"];
const SYNC_EPOCH_HEX_DIGITS: usize = 32;

pub(crate) fn config_invalid(message: impl Into<String>) -> NarsilError {
    NarsilError::new(ErrorCode::CONFIG_INVALID, message.into())
}

pub(crate) fn positive_integer(value: Option<&Value>) -> Option<u64> {
    non_negative_safe_integer(value).filter(|number| *number >= 1)
}

pub(crate) fn is_quantization_mode(value: &str) -> bool {
    QUANTIZATION_MODES.contains(&value)
}

pub(crate) fn is_storage_mode(value: &str) -> bool {
    STORAGE_MODES.contains(&value)
}

pub(crate) fn is_sync_epoch(value: &str) -> bool {
    value.len() == SYNC_EPOCH_HEX_DIGITS
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

pub(crate) fn describe(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_json(),
    }
}
