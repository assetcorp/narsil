use std::sync::Arc;

use super::EngineInner;
use super::adapter_registry::EmbeddingAdapters;
use super::index::IndexState;
use super::index_lifecycle::enforce_limits;
use super::query_suggestions::engine_hooks::{clear_leftovers_of_name, drop_suggestion_indexes_of};
use super::query_suggestions::stored_state::SuggestionState;
use super::synonyms::prepare_synonyms;
use super::vectors::IndexVectors;
use super::vectors::embedding::bind_embedding;
use crate::analysis::{Analyser, Language, ResolvedAnalysis};
use crate::config::{
    DEFAULT_MAX_PARTITIONS, IndexConfig, StopWordsSetting, TokenizerSetting,
    require_configuration_within_size_limit, require_surface_forms_for_partial_fields,
    validate_bm25_params, validate_index_name, validate_partition_config,
    validate_pattern_value_limit, validate_required_fields_in_schema, validate_storage,
    validate_vector_promotion,
};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::schema::{CompiledSchema, require_creatable_schema, schema_fields, validate_schema};

pub(crate) const DEFAULT_LANGUAGE: &str = "english";

/// Returns the number of partitions that a new index starts with: its `maxPartitions`, or one.
pub(crate) fn initial_partition_count(config: &IndexConfig) -> usize {
    config
        .partitions
        .and_then(|partitions| partitions.max_partitions)
        .map_or(DEFAULT_MAX_PARTITIONS as usize, |count| {
            usize::try_from(count).unwrap_or(usize::MAX)
        })
}

pub(crate) fn resolved_analysis(
    engine: &EngineInner,
    config: &IndexConfig,
) -> Result<ResolvedAnalysis> {
    let tokenizer = match &config.tokenizer {
        None => None,
        Some(TokenizerSetting::Instance(tokenizer)) => Some(tokenizer.clone()),
        Some(TokenizerSetting::Named(name)) => Some(engine.analysis.tokenizer(name)?),
    };
    let stop_words = match &config.stop_words {
        None => None,
        Some(StopWordsSetting::Words(words)) => Some(words.clone()),
        Some(StopWordsSetting::Named(name)) => Some(engine.analysis.stop_words(name)?),
    };
    Ok(ResolvedAnalysis {
        stop_words,
        tokenizer,
    })
}

fn require_persistable_analysis(name: &str, config: &IndexConfig) -> Result<()> {
    if matches!(config.tokenizer, Some(TokenizerSetting::Instance(_))) {
        return Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!(
                "Index \"{name}\" cannot use a tokenizer instance while durability is configured, because a checkpoint persists no code. Register it with registerTokenizer and pass its name"
            ),
        ));
    }
    if matches!(
        config.stop_words,
        Some(StopWordsSetting::Words(
            crate::analysis::StopWords::Function(_)
        ))
    ) {
        return Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            format!(
                "Index \"{name}\" cannot use a stop word function while durability is configured, because a checkpoint persists no code. Register it with registerStopWords and pass its name"
            ),
        ));
    }
    Ok(())
}

fn build_index(
    engine: &EngineInner,
    registered: &EmbeddingAdapters,
    name: &str,
    requested: IndexConfig,
) -> Result<IndexState> {
    let definition = validate_schema(&requested.schema)?;
    let fields = schema_fields(&definition)?;
    require_creatable_schema(&fields)?;
    let schema = CompiledSchema::of(definition)?;
    validate_pattern_value_limit(requested.pattern_value_limit)?;
    require_surface_forms_for_partial_fields(&schema, requested.surface_forms)?;
    if let Some(promotion) = &requested.vector_promotion {
        validate_vector_promotion(promotion)?;
    }
    validate_storage(&requested, engine.filesystem_durability())?;
    if let Some(bm25) = &requested.bm25 {
        validate_bm25_params(bm25, &schema, ErrorCode::CONFIG_INVALID, true)?;
    }
    if let Some(partitions) = &requested.partitions {
        validate_partition_config(partitions)?;
    }
    if engine.durable() {
        require_persistable_analysis(name, &requested)?;
    }
    let embedding = bind_embedding(requested.embedding.as_ref(), &schema, registered, false)?;
    if let Some(required) = &requested.required
        && !required.is_empty()
    {
        validate_required_fields_in_schema(required, &schema)?;
    }
    let language = Language::named(requested.language.as_deref().unwrap_or(DEFAULT_LANGUAGE))?;
    require_configuration_within_size_limit(&requested, &language)?;
    let analysis = resolved_analysis(engine, &requested)?;
    let analyser = Analyser::new(language, &analysis)?;
    let synonyms = prepare_synonyms(requested.synonyms.as_deref(), &analyser, true, "")?;
    let vectors = IndexVectors::new(&schema, &requested, embedding, Arc::clone(&engine.adapters))?;
    let partition_count = initial_partition_count(&requested);
    Ok(IndexState::new(
        name.to_string(),
        requested,
        schema,
        analyser,
        synonyms,
        vectors,
        partition_count,
    ))
}

/// Creates an index, refusing a name that the engine already holds, and then runs every plugin's
/// `on_index_create` hook and raises a write event, once the engine holds no lock of the index.
pub(crate) fn create_index(engine: &EngineInner, name: &str, config: IndexConfig) -> Result<()> {
    create_marked_index(engine, name, config, SuggestionState::default())
}

/// Creates an index that carries `suggestions`, such as the marker of a suggestions index, from the first file
/// that the engine writes for it, and announces it as [`create_index`] does.
pub(crate) fn create_marked_index(
    engine: &EngineInner,
    name: &str,
    config: IndexConfig,
    suggestions: SuggestionState,
) -> Result<()> {
    let state = create_unannounced(engine, name, config, suggestions)?;
    engine.lifecycle.touch(&state);
    enforce_limits(engine, Some(name));
    engine.plugins.index_created(name, &state.config());
    engine.events.wrote(name);
    Ok(())
}

fn create_unannounced(
    engine: &EngineInner,
    name: &str,
    config: IndexConfig,
    suggestions: SuggestionState,
) -> Result<Arc<IndexState>> {
    engine.guard_shutdown()?;
    validate_index_name(name)?;
    let _name = engine.names.take(name)?;
    let _admitted = engine.admit_publication()?;
    if engine.index(name).is_ok() || engine.lifecycle.holds_closed(name) {
        return Err(NarsilError::new(
            ErrorCode::INDEX_ALREADY_EXISTS,
            format!("Index \"{name}\" already exists"),
        ));
    }
    clear_leftovers_of_name(engine, name)?;
    let registered = engine.adapters.embedding();
    let state = Arc::new(build_index(engine, &registered, name, config)?);
    state.replace_suggestion_state(suggestions);
    if let Some(durable) = &engine.durable {
        durable.attach_created(&state)?;
    }
    engine
        .indexes_mut()
        .insert(name.to_string(), Arc::clone(&state));
    Ok(state)
}

/// Drops an index and everything that it holds, keeping it where its files fail to go, and then runs every
/// plugin's `on_index_drop` hook and raises a write event, once the engine holds no lock of the index.
pub(crate) fn drop_index(engine: &EngineInner, name: &str) -> Result<()> {
    engine.guard_shutdown()?;
    if !engine.holds_index(name) {
        return Err(NarsilError::new(
            ErrorCode::INDEX_NOT_FOUND,
            format!("Index \"{name}\" does not exist"),
        ));
    }
    let config = {
        let _writes = engine.suggestions.write_turns.take(name)?;
        drop_suggestion_indexes_of(engine, name)?;
        drop_unannounced(engine, name)?
    };
    engine.suggestions.on_drop(engine, name);
    engine.memory.memory_released();
    engine.events.forget(name);
    engine.plugins.index_dropped(name, &config);
    engine.events.wrote(name);
    Ok(())
}

fn drop_unannounced(engine: &EngineInner, name: &str) -> Result<Arc<IndexConfig>> {
    engine.guard_shutdown()?;
    let _name = engine.names.take(name)?;
    let Some(index) = engine.open_index_named(name) else {
        return drop_closed(engine, name);
    };
    let _writer = index.write_lock();
    if let Some(durable) = &engine.durable {
        durable.remove_index(name)?;
    }
    engine.indexes_mut().remove(name);
    engine.lifecycle.forget(name);
    index.retire();
    drop(_writer);
    Ok(index.config())
}

/// Drops an index that a close left on its files, while the caller holds the name's turn.
fn drop_closed(engine: &EngineInner, name: &str) -> Result<Arc<IndexConfig>> {
    let config = engine
        .lifecycle
        .registry()
        .entries
        .get(name)
        .map(|entry| Arc::clone(&entry.closed.config));
    let Some(config) = config else {
        return Err(NarsilError::new(
            ErrorCode::INDEX_NOT_FOUND,
            format!("Index \"{name}\" does not exist"),
        ));
    };
    if let Some(durable) = &engine.durable {
        durable.remove_index(name)?;
    }
    engine.lifecycle.forget(name);
    Ok(config)
}
