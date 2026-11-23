use crate::config::{
    IndexConfig, require_surface_forms_for_partial_fields, validate_bm25_params,
    validate_partition_config, validate_pattern_value_limit, validate_vector_promotion,
};
use crate::error::{ErrorCode, Result};
use crate::schema::{CompiledSchema, require_creatable_schema, schema_fields, validate_schema};
use crate::synonyms::rules::validate_synonym_rules;

const SYNONYMS_SOURCE: &str = "synonyms";

/// Checks that a cluster can create an index from `config`, as a controller does before it restores a backup:
/// the schema compiles and holds a field that an index can create, partial-word fields keep surface forms, and the
/// BM25 parameters, the partition limits, the vector promotion, the pattern value limit, and the synonym rules keep
/// within the engine's limits.
///
/// The check needs no engine, so it leaves out the registered names of tokenizers, stop word sets, embedding
/// adapters, and languages, which each data node checks as it creates its copy.
///
/// # Errors
///
/// Fails with the schema's or the configuration's error code where `config` breaks a rule.
pub fn require_restorable_config(config: &IndexConfig) -> Result<()> {
    let definition = validate_schema(&config.schema)?;
    require_creatable_schema(&schema_fields(&definition)?)?;
    let schema = CompiledSchema::of(definition)?;
    validate_pattern_value_limit(config.pattern_value_limit)?;
    require_surface_forms_for_partial_fields(&schema, config.surface_forms)?;
    if let Some(promotion) = &config.vector_promotion {
        validate_vector_promotion(promotion)?;
    }
    if let Some(bm25) = &config.bm25 {
        validate_bm25_params(bm25, &schema, ErrorCode::CONFIG_INVALID, true)?;
    }
    if let Some(partitions) = &config.partitions {
        validate_partition_config(partitions)?;
    }
    if let Some(rules) = &config.synonyms {
        validate_synonym_rules(rules, SYNONYMS_SOURCE)?;
    }
    Ok(())
}
