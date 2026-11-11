use std::path::PathBuf;
use std::sync::Arc;

use narsil::{
    AnalysisConfig, AnalysisRebuildMode, DurabilityConfig, DurabilityMode, DurabilityTier,
    EmbeddingAdapter, ErrorCode, IndexLifecycleConfig, MainCopyQueries, MemoryConfig, NarsilConfig,
    NarsilError, NarsilEventKind, Plugin, QuerySuggestionsConfig, RerankAdapter, StopWords,
    Tokenizer, WorkerConfig,
};
use pyo3::prelude::*;
use pyo3::types::{PyByteArray, PyBytes, PyString};

use super::fields::{Fields, choice_of, items_of, string_of};
use crate::callbacks::adapters::{PythonEmbeddingAdapter, PythonRerankAdapter};
use crate::callbacks::analysis::{stop_words_value, tokenizer_object};
use crate::callbacks::functions::{EVENT_KINDS, id_generator, stale_listener};
use crate::callbacks::persistence::persistence_adapter;
use crate::callbacks::plugins::PythonPlugin;
use crate::callbacks::retained::Retained;
use crate::errors::config_invalid;

const ENGINE_KEYS_REFUSING_NONE: [&str; 9] = [
    "patternWorkCap",
    "lifecycle",
    "memory",
    "rerankTimeout",
    "maxRerankWindow",
    "plugins",
    "tokenizers",
    "stopWords",
    "events",
];
const DURABILITY_KEYS_REFUSING_NONE: [&str; 7] = [
    "tier",
    "mode",
    "flushIntervalMs",
    "segmentMaxBytes",
    "checkpointIntervalMs",
    "checkpointMutationThreshold",
    "compactionThreshold",
];
const WORKER_KEYS_REFUSING_NONE: [&str; 4] = [
    "count",
    "promotionThreshold",
    "idleTimeoutMs",
    "mainCopyQueries",
];
const LIFECYCLE_KEYS_REFUSING_NONE: [&str; 4] = [
    "idleTimeoutMs",
    "maxOpenIndexes",
    "maxOpenBytes",
    "maxReopenWaiters",
];
const MEMORY_KEYS_REFUSING_NONE: [&str; 2] = ["blockWritesAbove", "resumeWritesBelow"];

#[derive(Default)]
pub(crate) struct EngineSetup {
    pub(crate) config: NarsilConfig,
    pub(crate) tokenizers: Vec<(String, Arc<dyn Tokenizer>)>,
    pub(crate) stop_words: Vec<(String, StopWords)>,
    pub(crate) embedding_adapters: Vec<(String, Arc<dyn EmbeddingAdapter>)>,
    pub(crate) rerank_adapters: Vec<(String, Arc<dyn RerankAdapter>)>,
    pub(crate) plugins: Vec<Arc<dyn Plugin>>,
    pub(crate) listeners: Vec<(NarsilEventKind, Retained)>,
}

fn durability(mut fields: Fields<'_>) -> Result<DurabilityConfig, NarsilError> {
    fields.refuse_each_none(&DURABILITY_KEYS_REFUSING_NONE, ErrorCode::CONFIG_INVALID)?;
    let directory_path = fields.path("directory");
    let directory = match fields.get("directory")? {
        None => None,
        Some(directory) => Some(
            directory
                .extract::<PathBuf>()
                .map_err(|_| config_invalid(format!("{directory_path} must be a path")))?,
        ),
    };
    let config = DurabilityConfig {
        tier: fields.choice(
            "tier",
            &[
                ("wal", DurabilityTier::Wal),
                ("snapshot", DurabilityTier::Snapshot),
            ],
        )?,
        directory,
        mode: fields.choice(
            "mode",
            &[
                ("sync", DurabilityMode::Sync),
                ("async", DurabilityMode::Async),
            ],
        )?,
        flush_interval_ms: fields.whole("flushIntervalMs")?,
        segment_max_bytes: fields.whole("segmentMaxBytes")?,
        checkpoint_interval_ms: fields.whole("checkpointIntervalMs")?,
        checkpoint_mutation_threshold: fields.whole("checkpointMutationThreshold")?,
        compaction_threshold: fields.whole_u32("compactionThreshold")?,
    };
    fields.finish()?;
    Ok(config)
}

fn workers(mut fields: Fields<'_>) -> Result<WorkerConfig, NarsilError> {
    fields.refuse_each_none(&WORKER_KEYS_REFUSING_NONE, ErrorCode::CONFIG_INVALID)?;
    let config = WorkerConfig {
        enabled: fields.boolean("enabled")?,
        count: fields.whole("count")?,
        promotion_threshold: fields.whole("promotionThreshold")?,
        idle_timeout_ms: fields.whole("idleTimeoutMs")?,
        main_copy_queries: fields.choice(
            "mainCopyQueries",
            &[
                ("lone", MainCopyQueries::Lone),
                ("none", MainCopyQueries::None),
            ],
        )?,
    };
    fields.finish()?;
    Ok(config)
}

fn lifecycle(mut fields: Fields<'_>) -> Result<IndexLifecycleConfig, NarsilError> {
    fields.refuse_each_none(&LIFECYCLE_KEYS_REFUSING_NONE, ErrorCode::CONFIG_INVALID)?;
    let config = IndexLifecycleConfig {
        idle_timeout_ms: fields.whole("idleTimeoutMs")?,
        max_open_indexes: fields.whole("maxOpenIndexes")?,
        max_open_bytes: fields.whole("maxOpenBytes")?,
        max_reopen_waiters: fields.whole("maxReopenWaiters")?,
    };
    fields.finish()?;
    Ok(config)
}

fn memory(mut fields: Fields<'_>) -> Result<MemoryConfig, NarsilError> {
    fields.refuse_each_none(&MEMORY_KEYS_REFUSING_NONE, ErrorCode::CONFIG_INVALID)?;
    let config = MemoryConfig {
        block_writes_above: fields.number("blockWritesAbove")?,
        resume_writes_below: fields.number("resumeWritesBelow")?,
    };
    fields.finish()?;
    Ok(config)
}

fn analysis(mut fields: Fields<'_>) -> Result<AnalysisConfig, NarsilError> {
    let listener_path = fields.path("onStaleAnalysis");
    let config = AnalysisConfig {
        rebuild: fields.choice(
            "rebuild",
            &[
                ("auto", AnalysisRebuildMode::Auto),
                ("manual", AnalysisRebuildMode::Manual),
            ],
        )?,
        on_stale_analysis: fields
            .get("onStaleAnalysis")?
            .map(|listener| stale_listener(&listener, &listener_path))
            .transpose()?,
    };
    fields.finish()?;
    Ok(config)
}

fn query_suggestions(mut fields: Fields<'_>) -> Result<QuerySuggestionsConfig, NarsilError> {
    let path = fields.path("key");
    let key = match fields.get("key")? {
        Some(key) if key.cast::<PyString>().is_ok() => string_of(&key, &path)?.into_bytes(),
        Some(key) if key.cast::<PyBytes>().is_ok() || key.cast::<PyByteArray>().is_ok() => key
            .extract::<Vec<u8>>()
            .map_err(|_| config_invalid(format!("{path} must be a string or bytes")))?,
        _ => return Err(config_invalid(format!("{path} must be a string or bytes"))),
    };
    fields.finish()?;
    Ok(QuerySuggestionsConfig { key })
}

fn named<T>(
    fields: &mut Fields<'_>,
    key: &'static str,
    wrap: impl Fn(&Bound<'_, PyAny>, &str, &str) -> Result<T, NarsilError>,
) -> Result<Vec<(String, T)>, NarsilError> {
    let Some(entries) = fields.fields(key)? else {
        return Ok(Vec::new());
    };
    let label = fields.path(key);
    let mut wrapped = Vec::new();
    for (name, value) in entries.entries() {
        let name = string_of(&name, &format!("{label} key"))?;
        let path = format!("{label}.{name}");
        wrapped.push((name.clone(), wrap(&value, &path, &name)?));
    }
    Ok(wrapped)
}

fn listeners(fields: &mut Fields<'_>) -> Result<Vec<(NarsilEventKind, Retained)>, NarsilError> {
    let Some(entries) = fields.fields("events")? else {
        return Ok(Vec::new());
    };
    let label = fields.path("events");
    let mut listeners = Vec::new();
    for (kind, listener) in entries.entries() {
        let kind = string_of(&kind, &format!("{label} key"))?;
        let path = format!("{label}.{kind}");
        let kind = choice_of(&kind, &format!("{label} key"), &EVENT_KINDS)?;
        if !listener.is_callable() {
            return Err(config_invalid(format!("{path} must be a function")));
        }
        listeners.push((kind, Retained::new(&listener)));
    }
    Ok(listeners)
}

pub(crate) fn engine_setup(value: Option<&Bound<'_, PyAny>>) -> Result<EngineSetup, NarsilError> {
    let Some(value) = value.filter(|value| !value.is_none()) else {
        return Ok(EngineSetup::default());
    };
    let mut fields = Fields::of(value, "config")?;
    fields.refuse_each_none(&ENGINE_KEYS_REFUSING_NONE, ErrorCode::CONFIG_INVALID)?;
    fields.refuse_none("persistence", ErrorCode::PERSISTENCE_LOAD_FAILED)?;
    let persistence_path = fields.path("persistence");
    let generator_path = fields.path("idGenerator");
    let plugins_path = fields.path("plugins");
    let config = NarsilConfig {
        durability: fields.fields("durability")?.map(durability).transpose()?,
        persistence: fields
            .get("persistence")?
            .map(|adapter| persistence_adapter(&adapter, &persistence_path))
            .transpose()?,
        pattern_work_cap: fields.whole("patternWorkCap")?,
        workers: fields.fields("workers")?.map(workers).transpose()?,
        lifecycle: fields.fields("lifecycle")?.map(lifecycle).transpose()?,
        memory: fields.fields("memory")?.map(memory).transpose()?,
        analysis: fields.fields("analysis")?.map(analysis).transpose()?,
        id_generator: fields
            .get("idGenerator")?
            .map(|generator| id_generator(&generator, &generator_path))
            .transpose()?,
        rerank_timeout_ms: fields.whole("rerankTimeout")?,
        max_rerank_window: fields.size("maxRerankWindow")?,
        query_suggestions: fields
            .fields("querySuggestions")?
            .map(query_suggestions)
            .transpose()?,
    };
    let plugins = match fields.get("plugins")? {
        None => Vec::new(),
        Some(plugins) => items_of(&plugins, &plugins_path)?
            .iter()
            .enumerate()
            .map(|(at, plugin)| PythonPlugin::wrap(plugin, &format!("{plugins_path}[{at}]")))
            .collect::<Result<_, _>>()?,
    };
    let setup = EngineSetup {
        config,
        tokenizers: named(&mut fields, "tokenizers", |value, path, _| {
            tokenizer_object(value, path)
        })?,
        stop_words: named(&mut fields, "stopWords", |value, path, _| {
            stop_words_value(value, path)
        })?,
        embedding_adapters: named(&mut fields, "embeddingAdapters", |value, path, _| {
            PythonEmbeddingAdapter::wrap(value, path)
        })?,
        rerank_adapters: named(&mut fields, "rerankAdapters", |value, _, name| {
            PythonRerankAdapter::wrap(value, name)
        })?,
        plugins,
        listeners: listeners(&mut fields)?,
    };
    fields.finish()?;
    Ok(setup)
}
