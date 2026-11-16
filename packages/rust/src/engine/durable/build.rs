use std::sync::Arc;

use super::metadata::config_of;
use crate::analysis::Analyser;
use crate::config::{
    IndexConfig, compiled_config_schema, validate_partition_config, validate_storage,
};
use crate::engine::EngineInner;
use crate::engine::changes::analysis::terms_are_stale;
use crate::engine::index::IndexState;
use crate::engine::lifecycle::{DEFAULT_LANGUAGE, resolved_analysis};
use crate::engine::query_suggestions::stored_state::SuggestionState;
use crate::engine::synonyms::{SynonymSet, prepare_synonyms};
use crate::engine::vectors::IndexVectors;
use crate::engine::vectors::embedding::bind_embedding;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::metadata::IndexMetadata;
use crate::schema::CompiledSchema;
use crate::synonyms::wire::synonym_rules_of;
use crate::value::{Map, Value};

const STORED_SYNONYMS_SOURCE: &str = "The synonym set in the index metadata is invalid: ";
const RECOVERY_CONFIG_ERROR_CODES: [ErrorCode; 4] = [
    ErrorCode::CONFIG_INVALID,
    ErrorCode::LANGUAGE_NOT_SUPPORTED,
    ErrorCode::SCHEMA_INVALID_TYPE,
    ErrorCode::SCHEMA_INVALID_VECTOR_DIMENSION,
];

fn prefixed(name: &str, error: &NarsilError) -> NarsilError {
    let message = format!("Recovery of index \"{name}\" failed: {}", error.message());
    NarsilError::new(error.code(), message)
}

fn set_or_remove(details: &mut Map, key: &str, value: Option<&str>) {
    match value {
        Some(value) => {
            details.insert(key, Value::from(value));
        }
        None => {
            details.remove(key);
        }
    }
}

fn embedding_failure(metadata: &IndexMetadata, error: NarsilError) -> NarsilError {
    let adapter = metadata
        .embedding
        .as_ref()
        .and_then(|embedding| embedding.adapter.as_deref());
    prefixed(&metadata.index_name, &error).with_details(
        [("indexName", Value::from(metadata.index_name.as_str()))]
            .into_iter()
            .chain(adapter.map(|adapter| ("adapter", Value::from(adapter)))),
    )
}

pub(super) fn recovery_failure(metadata: &IndexMetadata, error: NarsilError) -> NarsilError {
    if !RECOVERY_CONFIG_ERROR_CODES.contains(&error.code()) {
        return error;
    }
    let mut details = error.details().cloned().unwrap_or_default();
    details.insert("indexName", Value::from(metadata.index_name.as_str()));
    set_or_remove(
        &mut details,
        "tokenizer",
        metadata.analysis.tokenizer.as_deref(),
    );
    set_or_remove(
        &mut details,
        "stopWords",
        metadata.analysis.stop_words.as_deref(),
    );
    prefixed(&metadata.index_name, &error).with_details(details)
}

fn checked_schema(config: &IndexConfig) -> Result<CompiledSchema> {
    let schema = compiled_config_schema(config)?;
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
    let config = config_of(metadata).map_err(|error| recovery_failure(metadata, error))?;
    let language = engine
        .settings
        .languages
        .resolve(config.language.as_deref().unwrap_or(DEFAULT_LANGUAGE))
        .map_err(|error| recovery_failure(metadata, error))?;
    let schema = checked_schema(&config).map_err(|error| recovery_failure(metadata, error))?;
    let embedding = {
        let registered = engine.adapters.embedding();
        bind_embedding(config.embedding.as_ref(), &schema, &registered, true)
            .map_err(|error| embedding_failure(metadata, error))?
    };
    let analysis =
        resolved_analysis(engine, &config).map_err(|error| recovery_failure(metadata, error))?;
    let analyser =
        Analyser::new(language, &analysis).map_err(|error| recovery_failure(metadata, error))?;
    let synonyms = stored_synonyms(metadata, &analyser)?;
    validate_storage(&config, engine.filesystem_durability())
        .map_err(|error| recovery_failure(metadata, error))?;
    let vectors = IndexVectors::new(&schema, &config, embedding, Arc::clone(&engine.adapters))
        .map_err(|error| recovery_failure(metadata, error))?;
    let suggestions = SuggestionState::from_metadata(metadata)
        .map_err(|error| recovery_failure(metadata, error))?;
    let partition_count = usize::try_from(metadata.partition_count.max(1)).unwrap_or(usize::MAX);
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
