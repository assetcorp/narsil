use std::sync::Arc;

use super::metadata::config_of;
use crate::analysis::{Analyser, Language};
use crate::config::{
    IndexConfig, require_surface_forms_for_partial_fields, validate_partition_config,
    validate_pattern_value_limit, validate_storage,
};
use crate::engine::EngineInner;
use crate::engine::changes::analysis::terms_are_stale;
use crate::engine::index::IndexState;
use crate::engine::lifecycle::{DEFAULT_LANGUAGE, initial_partition_count, resolved_analysis};
use crate::engine::query_suggestions::stored_state::SuggestionState;
use crate::engine::synonyms::{SynonymSet, prepare_synonyms};
use crate::engine::vectors::IndexVectors;
use crate::engine::vectors::embedding::bind_embedding;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::metadata::IndexMetadata;
use crate::schema::{CompiledSchema, schema_fields, validate_schema};
use crate::synonyms::wire::synonym_rules_of;

const STORED_SYNONYMS_SOURCE: &str = "The synonym set in the index metadata is invalid: ";
const RECOVERY_CONFIG_ERROR_CODES: [ErrorCode; 3] = [
    ErrorCode::CONFIG_INVALID,
    ErrorCode::SCHEMA_INVALID_TYPE,
    ErrorCode::SCHEMA_INVALID_VECTOR_DIMENSION,
];

fn prefixed(name: &str, error: NarsilError) -> NarsilError {
    let message = format!("Recovery of index \"{name}\" failed: {}", error.message());
    NarsilError::new(error.code(), message)
}

pub(super) fn recovery_failure(name: &str, error: NarsilError) -> NarsilError {
    if RECOVERY_CONFIG_ERROR_CODES.contains(&error.code()) {
        return prefixed(name, error);
    }
    error
}

fn checked_schema(config: &IndexConfig) -> Result<CompiledSchema> {
    let definition = validate_schema(&config.schema)?;
    schema_fields(&definition)?;
    let schema = CompiledSchema::of(definition)?;
    validate_pattern_value_limit(config.pattern_value_limit)?;
    require_surface_forms_for_partial_fields(&schema, config.surface_forms)?;
    if let Some(partitions) = &config.partitions {
        validate_partition_config(partitions)?;
    }
    Ok(schema)
}

fn stored_synonyms(metadata: &IndexMetadata, analyser: &Analyser) -> Result<SynonymSet> {
    let Some(value) = &metadata.synonyms else {
        return Ok(SynonymSet::default());
    };
    let rules = synonym_rules_of(value, STORED_SYNONYMS_SOURCE)?;
    prepare_synonyms(Some(&rules), analyser, false, STORED_SYNONYMS_SOURCE)
}

/// Builds an empty index from the metadata that a durable engine stored, checking it in the order that every
/// Narsil engine checks a stored index.
pub(crate) fn recovered_index(
    engine: &EngineInner,
    metadata: &IndexMetadata,
) -> Result<IndexState> {
    let name = metadata.index_name.as_str();
    let config = config_of(metadata).map_err(|error| recovery_failure(name, error))?;
    let language = Language::named(config.language.as_deref().unwrap_or(DEFAULT_LANGUAGE))?;
    let schema = checked_schema(&config).map_err(|error| recovery_failure(name, error))?;
    let embedding = {
        let registered = engine.adapters.embedding();
        bind_embedding(config.embedding.as_ref(), &schema, &registered, true)
            .map_err(|error| prefixed(name, error))?
    };
    let analysis =
        resolved_analysis(engine, &config).map_err(|error| recovery_failure(name, error))?;
    let analyser =
        Analyser::new(language, &analysis).map_err(|error| recovery_failure(name, error))?;
    let synonyms = stored_synonyms(metadata, &analyser)?;
    validate_storage(&config, engine.filesystem_durability())
        .map_err(|error| recovery_failure(name, error))?;
    let vectors = IndexVectors::new(&schema, &config, embedding, Arc::clone(&engine.adapters))
        .map_err(|error| recovery_failure(name, error))?;
    let suggestions =
        SuggestionState::from_metadata(metadata).map_err(|error| recovery_failure(name, error))?;
    let partition_count = initial_partition_count(&config);
    let index = IndexState::new(
        name.to_string(),
        config,
        schema,
        analyser,
        synonyms,
        vectors,
        partition_count,
    );
    index.set_analysis_stale(terms_are_stale(&index, metadata));
    index.replace_suggestion_state(suggestions);
    Ok(index)
}
