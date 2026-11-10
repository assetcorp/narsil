use super::types::{
    Bm25FieldParams, Bm25Params, IndexConfig, PartitionConfig, Storage, VectorPromotion,
};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::schema::CompiledSchema;
use crate::util::text::utf16_length;
use crate::value::number_to_text;

pub(crate) const MAX_INDEX_NAME_LENGTH: usize = 255;
pub(crate) const MAX_DOC_ID_LENGTH: usize = 512;
pub(crate) const MAX_BM25_K1: f64 = 1000.0;
pub(crate) const MAX_BM25_B: f64 = 1.0;
pub(crate) const DEFAULT_BM25_K1: f64 = 1.2;
pub(crate) const DEFAULT_BM25_B: f64 = 0.75;
pub(crate) const BM25_DISPLAYED_NAME_LENGTH: usize = 64;
pub(crate) const MIN_PATTERN_VALUE_LIMIT: u64 = 1;
pub(crate) const MAX_PATTERN_VALUE_LIMIT: u64 = 65_536;
pub(crate) const MIN_M: u32 = 2;
pub(crate) const MAX_M: u32 = 512;
pub(crate) const MAX_PARTITIONS: u64 = 65_536;
pub(crate) const DEFAULT_MAX_PARTITIONS: u64 = 1;

/// Returns the `maxPartitions` that a stored index loads under: the stored count, or 65,536 where an earlier
/// release stored more.
pub(crate) fn stored_max_partitions(count: Option<u64>) -> Option<u64> {
    count.map(|count| count.min(MAX_PARTITIONS))
}

fn invalid(message: impl Into<String>) -> NarsilError {
    NarsilError::new(ErrorCode::CONFIG_INVALID, message.into())
}

/// Raises `CONFIG_INVALID` for an index name outside the characters and length that every Narsil engine accepts.
pub(crate) fn validate_index_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(invalid(
            "Index name must be a string of at least one character",
        ));
    }
    if utf16_length(name) > MAX_INDEX_NAME_LENGTH {
        return Err(invalid(format!(
            "Index name must not exceed {MAX_INDEX_NAME_LENGTH} characters"
        )));
    }
    let bytes = name.as_bytes();
    let first_allowed = bytes[0].is_ascii_alphanumeric();
    let rest_allowed = bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if !first_allowed || !rest_allowed {
        return Err(invalid(format!(
            "Index name \"{name}\" contains invalid characters; use alphanumeric, dots, hyphens, and underscores only"
        )));
    }
    if name.contains("..") {
        return Err(invalid(format!(
            "Index name \"{name}\" must not contain \"..\""
        )));
    }
    Ok(())
}

/// Raises `DOC_VALIDATION_FAILED` for a document ID that no Narsil engine can store.
pub(crate) fn validate_doc_id(doc_id: &str) -> Result<()> {
    let failed = |message: String| NarsilError::new(ErrorCode::DOC_VALIDATION_FAILED, message);
    if doc_id.is_empty() {
        return Err(failed("Document ID must not be empty".to_string()));
    }
    if utf16_length(doc_id) > MAX_DOC_ID_LENGTH {
        return Err(failed(format!(
            "Document ID must not exceed {MAX_DOC_ID_LENGTH} characters"
        )));
    }
    if doc_id.contains('\0') {
        return Err(failed(
            "Document ID must not contain null bytes".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_partition_config(partitions: &PartitionConfig) -> Result<()> {
    if partitions.max_docs_per_partition == Some(0) {
        return Err(invalid(
            "partitions.maxDocsPerPartition must be a positive integer",
        ));
    }
    if partitions.max_partitions == Some(0) {
        return Err(invalid(
            "partitions.maxPartitions must be a positive integer",
        ));
    }
    if partitions
        .max_partitions
        .is_some_and(|count| count > MAX_PARTITIONS)
    {
        return Err(invalid(format!(
            "partitions.maxPartitions must be at most {MAX_PARTITIONS}"
        )));
    }
    if let Some(watermark) = partitions.watermark
        && !(watermark > 0.0 && watermark <= 1.0)
    {
        return Err(invalid(
            "partitions.watermark must be above 0 and at most 1",
        ));
    }
    Ok(())
}

pub(crate) fn validate_pattern_value_limit(limit: Option<u64>) -> Result<()> {
    match limit {
        Some(limit) if !(MIN_PATTERN_VALUE_LIMIT..=MAX_PATTERN_VALUE_LIMIT).contains(&limit) => {
            Err(invalid(format!(
                "patternValueLimit must be a whole number of code points from {MIN_PATTERN_VALUE_LIMIT} to {MAX_PATTERN_VALUE_LIMIT}"
            )))
        }
        _ => Ok(()),
    }
}

pub(crate) fn require_surface_forms_for_partial_fields(
    schema: &CompiledSchema,
    surface_forms: Option<bool>,
) -> Result<()> {
    if surface_forms != Some(false) {
        return Ok(());
    }
    let partial = schema.partial_fields();
    let Some(first) = partial.first() else {
        return Ok(());
    };
    Err(invalid(format!(
        "Field \"{first}\" declares \"partial\", which compares words as the documents wrote them, so its index needs surfaceForms left on"
    )))
}

pub(crate) fn validate_vector_promotion(promotion: &VectorPromotion) -> Result<()> {
    if promotion.threshold == Some(0) {
        return Err(invalid(
            "vectorPromotion.threshold must be a positive integer",
        ));
    }
    let Some(hnsw) = promotion.hnsw else {
        return Ok(());
    };
    if let Some(m) = hnsw.m
        && !(MIN_M..=MAX_M).contains(&m)
    {
        return Err(invalid(format!(
            "vectorPromotion.hnswConfig.m must be a whole number from {MIN_M} to {MAX_M}"
        )));
    }
    if hnsw.ef_construction == Some(0) {
        return Err(invalid(
            "vectorPromotion.hnswConfig.efConstruction must be a positive integer",
        ));
    }
    Ok(())
}

pub(crate) fn validate_storage(config: &IndexConfig, filesystem_durability: bool) -> Result<()> {
    let vector_storage = config
        .vector_promotion
        .as_ref()
        .and_then(|promotion| promotion.storage);
    if vector_storage == Some(Storage::Disk) && !filesystem_durability {
        return Err(invalid(
            "vectorPromotion.storage 'disk' needs filesystem durability, because a checkpoint file holds the vectors",
        ));
    }
    if config.text_storage == Some(Storage::Disk) && !filesystem_durability {
        return Err(invalid(
            "textStorage must be 'memory', or 'disk' with filesystem durability",
        ));
    }
    Ok(())
}

fn displayed_name(name: &str) -> String {
    name.chars().take(BM25_DISPLAYED_NAME_LENGTH).collect()
}

fn require_bm25_value(label: &str, value: Option<f64>, maximum: f64, settable: bool) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let usable = value.is_finite() && (!settable || (0.0..=maximum).contains(&value));
    if usable {
        return Ok(());
    }
    Err(invalid(format!(
        "{label} must be a finite number from 0 to {}, and this request sets {}",
        number_to_text(maximum),
        number_to_text(value)
    )))
}

fn require_bm25_pair(label: &str, pair: &Bm25FieldParams, settable: bool) -> Result<()> {
    require_bm25_value(&format!("{label}.k1"), pair.k1, MAX_BM25_K1, settable)?;
    require_bm25_value(&format!("{label}.b"), pair.b, MAX_BM25_B, settable)
}

/// Checks BM25 parameters, raising `unknown_field_code` for a field name that is no text field of the schema.
pub(crate) fn validate_bm25_params(
    params: &Bm25Params,
    schema: &CompiledSchema,
    unknown_field_code: ErrorCode,
    settable: bool,
) -> Result<()> {
    require_bm25_value("bm25.k1", params.k1, MAX_BM25_K1, settable)?;
    require_bm25_value("bm25.b", params.b, MAX_BM25_B, settable)?;
    let Some(fields) = &params.fields else {
        return Ok(());
    };
    for (name, pair) in fields {
        let shown = displayed_name(name);
        match schema.field_type(name) {
            Some(field_type) if field_type.base.is_word_indexed() => {}
            Some(field_type) => {
                return Err(NarsilError::new(
                    unknown_field_code,
                    format!(
                        "BM25 parameters apply to a text field alone, and the schema declares field \"{shown}\" as \"{}\"",
                        displayed_name(&field_type.name)
                    ),
                ));
            }
            None => {
                return Err(NarsilError::new(
                    unknown_field_code,
                    format!(
                        "BM25 parameters apply to a text field that the schema declares, and the schema declares no field \"{shown}\""
                    ),
                ));
            }
        }
        require_bm25_pair(&format!("bm25.fields.{shown}"), pair, settable)?;
    }
    Ok(())
}

fn embedding_invalid(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::EMBEDDING_CONFIG_INVALID, message)
}

pub(crate) fn validate_required_fields_in_schema(
    required: &[String],
    schema: &CompiledSchema,
) -> Result<()> {
    for field in required {
        if schema.field(field).is_none() {
            return Err(embedding_invalid(format!(
                "Required field \"{field}\" does not exist in the schema"
            )));
        }
    }
    Ok(())
}
