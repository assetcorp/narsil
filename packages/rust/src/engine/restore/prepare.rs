use std::sync::Arc;

use crate::analysis::{Analyser, Language};
use crate::config::{
    IndexConfig, Rejection, require_surface_forms_for_partial_fields, restored_config_fields,
    restored_embedding, validate_pattern_value_limit, validate_required_fields_in_schema,
    validate_storage, validate_vector_promotion,
};
use crate::engine::EngineInner;
use crate::engine::durable::metadata::created_metadata;
use crate::engine::index::IndexState;
use crate::engine::lifecycle::{initial_partition_count, resolved_analysis};
use crate::engine::query_suggestions::stored_state::SuggestionState;
use crate::engine::synonyms::{SynonymSet, prepare_synonyms};
use crate::engine::vectors::IndexVectors;
use crate::engine::vectors::embedding::bind_embedding;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::metadata::IndexMetadata;
use crate::schema::{CompiledSchema, schema_fields, validate_schema};
use crate::synonyms::wire::synonym_rules_of;
use crate::value::{MAX_SAFE_INTEGER, Map, Value};

/// An index built from a restored configuration, outside the engine until the restore installs it, with the
/// metadata facts that the configuration recorded about the analysis that built its terms.
pub(crate) struct PreparedIndex {
    pub(crate) index: IndexState,
    pub(crate) recorded: IndexMetadata,
}

/// Returns the refusal of a snapshot archive's configuration.
pub(crate) fn archive_rejection(message: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        format!("Invalid index configuration: {message}"),
    )
}

/// Returns the refusal of a release 0.3 snapshot file.
pub(crate) fn snapshot_rejection(message: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::DOC_VALIDATION_FAILED,
        format!("Invalid snapshot: {message}"),
    )
}

fn analysis_generation(payload: &Map) -> u64 {
    match payload.get("analysisGeneration") {
        Some(Value::Number(number))
            if number.fract() == 0.0
                && number.abs() <= MAX_SAFE_INTEGER as f64
                && *number > 0.0 =>
        {
            *number as u64
        }
        _ => 0,
    }
}

fn restored_synonyms(raw: &Value, analyser: &Analyser) -> Result<SynonymSet> {
    let rules = synonym_rules_of(raw, "")?;
    prepare_synonyms(Some(&rules), analyser, false, "")
}

fn recorded_metadata(name: &str, language: &Language, payload: &Map) -> IndexMetadata {
    let mut recorded = created_metadata(name, language);
    recorded.analysis_revision = match payload.get("analysisRevision") {
        Some(Value::String(revision)) => Some(revision.clone()),
        _ => None,
    };
    recorded.array_position_gap = match payload.get("arrayPositionGap") {
        Some(Value::Number(gap)) => Some(*gap),
        _ => None,
    };
    let generation = analysis_generation(payload);
    recorded.analysis_generation = (generation > 0).then_some(generation);
    recorded
}

/// Builds the index that a restored configuration describes, checking it in the order that every Narsil engine
/// checks a restored configuration, and refusing each bad field through `reject`.
pub(crate) fn prepare_restored_index(
    engine: &EngineInner,
    name: &str,
    payload: &Map,
    reject: Rejection<'_>,
) -> Result<PreparedIndex> {
    let mut config: IndexConfig = restored_config_fields(payload, reject)?;
    config.embedding = match payload.get("embedding") {
        None => None,
        Some(raw) => Some(restored_embedding(raw, reject)?),
    };
    let language_name = payload
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let language = Language::named(&language_name)?;
    config.language = Some(language_name);
    config.schema = payload.get("schema").cloned().unwrap_or(Value::Null);
    let definition = validate_schema(&config.schema)?;
    schema_fields(&definition)?;
    let schema = CompiledSchema::of(definition)?;
    validate_pattern_value_limit(config.pattern_value_limit)?;
    require_surface_forms_for_partial_fields(&schema, config.surface_forms)?;
    if let Some(promotion) = &config.vector_promotion {
        validate_vector_promotion(promotion)?;
    }
    validate_storage(&config, engine.filesystem_durability())?;
    if let Some(required) = &config.required
        && !required.is_empty()
    {
        validate_required_fields_in_schema(required, &schema)?;
    }
    let analysis = resolved_analysis(engine, &config)?;
    let embedding = {
        let registered = engine.adapters.embedding();
        bind_embedding(config.embedding.as_ref(), &schema, &registered, true)?
    };
    let analyser = Analyser::new(language.clone(), &analysis)?;
    let synonyms = match payload.get("synonyms") {
        None | Some(Value::Null) => None,
        Some(raw) => Some(restored_synonyms(raw, &analyser).map_err(|error| {
            if error.code() == ErrorCode::CONFIG_INVALID {
                reject(&format!("synonyms: {}", error.message()))
            } else {
                error
            }
        })?),
    };
    let vectors = IndexVectors::new(&schema, &config, embedding, Arc::clone(&engine.adapters))?;
    let partition_count = initial_partition_count(&config);
    let recorded = recorded_metadata(name, &language, payload);
    let suggestions = SuggestionState::from_payload(payload)?;
    let index = IndexState::new(
        name.to_string(),
        config,
        schema,
        analyser,
        synonyms.unwrap_or_default(),
        vectors,
        partition_count,
    );
    index.replace_suggestion_state(suggestions);
    Ok(PreparedIndex { index, recorded })
}
