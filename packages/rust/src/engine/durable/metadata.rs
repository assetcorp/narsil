use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::analysis::{Language, StopWords};
use crate::config::{
    AdapterSetting, Bm25FieldParams, Bm25Params, EmbeddingConfig, HnswSettings, IndexConfig,
    Metric, PartitionConfig, Quantization, ScoringMode, StopWordsSetting, Storage,
    TokenizerSetting, VectorPromotion, stored_max_partitions, synonym_rules_payload,
};
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::ENGINE_VERSION;
use crate::format::metadata::IndexMetadata;
use crate::format::metadata_parts::{
    self as parts, DEFAULT_BM25_B, DEFAULT_BM25_K1, EmbeddingMetadata, EmbeddingSource, FieldBm25,
    PartitionLimits, VectorFieldMetadata,
};
use crate::index::constants::ARRAY_POSITION_GAP;
use crate::schema::{flatten_schema, nest_schema};
use crate::value::{Map, Value};
use crate::vector::settings::default_quantization_for;

const EARLIER_RELEASE_GRAPH_M: u64 = 1;
const RAISED_EARLIER_RELEASE_GRAPH_M: u32 = 2;

fn engine_version() -> String {
    let [major, minor, patch] = ENGINE_VERSION;
    format!("{major}.{minor}.{patch}")
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

/// Returns the metadata that a new durable index starts from, which records the analysis that built its terms.
pub(crate) fn created_metadata(name: &str, language: &Language) -> IndexMetadata {
    let mut metadata = IndexMetadata::new(name, Map::new());
    metadata.analysis_revision = Some(language.revision().to_string());
    metadata.array_position_gap = Some(f64::from(ARRAY_POSITION_GAP));
    metadata
}

fn bm25_metadata(config: &IndexConfig) -> parts::Bm25Params {
    let bm25 = config.bm25.as_ref();
    parts::Bm25Params {
        k1: bm25.and_then(|params| params.k1).unwrap_or(DEFAULT_BM25_K1),
        b: bm25.and_then(|params| params.b).unwrap_or(DEFAULT_BM25_B),
        fields: bm25
            .and_then(|params| params.fields.as_ref())
            .map(|fields| {
                fields
                    .iter()
                    .map(|(path, pair)| {
                        let pair = FieldBm25 {
                            k1: pair.k1,
                            b: pair.b,
                        };
                        (path.clone(), pair)
                    })
                    .collect()
            }),
    }
}

fn promotion_metadata(promotion: &VectorPromotion) -> parts::VectorPromotion {
    parts::VectorPromotion {
        threshold: promotion.threshold,
        filter_threshold: promotion.filter_threshold,
        hnsw: promotion.hnsw.map(|hnsw| parts::HnswSettings {
            m: hnsw.m.map(u64::from),
            ef_construction: hnsw.ef_construction.map(u64::from),
            metric: hnsw.metric.map(|metric| metric.name().to_string()),
        }),
        quantization: promotion
            .quantization
            .map(|quantization| quantization.name().to_string()),
        storage: promotion.storage.map(|storage| storage.name().to_string()),
    }
}

fn vector_fields_metadata(index: &IndexState) -> Option<Vec<(String, VectorFieldMetadata)>> {
    let config = index.config();
    let promotion = config.vector_promotion.as_ref();
    let metric = promotion
        .and_then(|found| found.hnsw)
        .and_then(|hnsw| hnsw.metric)
        .unwrap_or(Metric::Cosine);
    let fields: Vec<_> = index
        .vectors
        .fields()
        .iter()
        .map(|entry| {
            let dimension = entry.field.dimension();
            let quantization = promotion
                .and_then(|found| found.quantization)
                .unwrap_or_else(|| default_quantization_for(dimension));
            let field = VectorFieldMetadata {
                dimension: u32::try_from(dimension).unwrap_or(u32::MAX),
                metric: metric.name().to_string(),
                quantization: quantization.name().to_string(),
            };
            (entry.path.clone(), field)
        })
        .collect();
    (!fields.is_empty()).then_some(fields)
}

fn embedding_metadata(index: &IndexState) -> Option<EmbeddingMetadata> {
    let binding = index.vectors.embedding()?;
    let fields = binding
        .fields
        .iter()
        .map(|(target, sources)| {
            let source = match sources.as_slice() {
                [only] => EmbeddingSource::One(only.clone()),
                _ => EmbeddingSource::Many(sources.clone()),
            };
            (target.clone(), source)
        })
        .collect();
    Some(EmbeddingMetadata {
        adapter: binding.adapter_name().map(str::to_string),
        fields,
    })
}

fn stop_word_list(words: &HashSet<String>) -> Vec<String> {
    let mut list: Vec<String> = words.iter().cloned().collect();
    list.sort_unstable();
    list
}

/// Builds the metadata that a durable index writes, keeping from `base` every recorded fact that its configuration
/// does not hold.
pub(crate) fn metadata_of(index: &IndexState, base: &IndexMetadata) -> IndexMetadata {
    let config = &*index.config();
    let layout = index.partitions();
    let mut metadata = base.clone();
    metadata.schema = config
        .schema
        .as_object()
        .map(flatten_schema)
        .unwrap_or_default();
    metadata.language = layout.analyser.language().name().to_string();
    metadata.partition_count = u32::try_from(layout.len()).unwrap_or(u32::MAX);
    metadata.document_count = Some(index.document_count());
    metadata.bm25 = bm25_metadata(config);
    metadata.created_at = now_ms();
    metadata.engine_version = engine_version();
    metadata.vector_fields = vector_fields_metadata(index);
    metadata.embedding = embedding_metadata(index);
    metadata.surface_forms = Some(config.surface_forms != Some(false));
    metadata.analysis.tokenizer = match &config.tokenizer {
        Some(TokenizerSetting::Named(name)) => Some(name.clone()),
        _ => None,
    };
    metadata.analysis.stop_words = match &config.stop_words {
        Some(StopWordsSetting::Named(name)) => Some(name.clone()),
        _ => None,
    };
    metadata.analysis.stop_word_list = match &config.stop_words {
        Some(StopWordsSetting::Words(StopWords::Set(words))) => Some(stop_word_list(words)),
        _ => None,
    };
    metadata.partition_limits = config.partitions.map(|limits| PartitionLimits {
        max_docs_per_partition: limits.max_docs_per_partition,
        max_partitions: limits.max_partitions,
        watermark: limits.watermark,
    });
    metadata.default_scoring = config.default_scoring.map(|mode| mode.name().to_string());
    metadata.track_positions = config.track_positions;
    metadata.text_storage = config
        .text_storage
        .map(|storage| storage.name().to_string());
    metadata.strict = config.strict;
    metadata.required = config.required.clone();
    metadata.vector_promotion = config.vector_promotion.as_ref().map(promotion_metadata);
    metadata.pattern_value_limit = config.pattern_value_limit;
    let rules = layout.synonyms.rules.clone();
    metadata.synonyms = (!rules.is_empty()).then(|| synonym_rules_payload(&rules));
    index.suggestion_state().write_metadata(&mut metadata);
    metadata
}

fn config_invalid(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::CONFIG_INVALID, message)
}

fn restored_hnsw(hnsw: &parts::HnswSettings) -> Result<HnswSettings> {
    let m = match hnsw.m {
        None => None,
        Some(EARLIER_RELEASE_GRAPH_M) => Some(RAISED_EARLIER_RELEASE_GRAPH_M),
        Some(m) => Some(u32::try_from(m).map_err(|_| {
            config_invalid(format!(
                "Index metadata gives a vector graph m of {m}, which this engine does not read"
            ))
        })?),
    };
    Ok(HnswSettings {
        m,
        ef_construction: hnsw
            .ef_construction
            .map(|ef| u32::try_from(ef).unwrap_or(u32::MAX)),
        metric: hnsw.metric.as_deref().and_then(Metric::parse),
    })
}

fn restored_promotion(promotion: &parts::VectorPromotion) -> Result<VectorPromotion> {
    Ok(VectorPromotion {
        threshold: promotion.threshold,
        filter_threshold: promotion.filter_threshold,
        hnsw: promotion.hnsw.as_ref().map(restored_hnsw).transpose()?,
        quantization: promotion
            .quantization
            .as_deref()
            .and_then(Quantization::parse),
        storage: promotion.storage.as_deref().and_then(Storage::parse),
    })
}

fn restored_embedding(embedding: &EmbeddingMetadata) -> EmbeddingConfig {
    EmbeddingConfig {
        fields: embedding
            .fields
            .iter()
            .map(|(target, source)| {
                let sources = match source {
                    EmbeddingSource::One(path) => vec![path.clone()],
                    EmbeddingSource::Many(paths) => paths.clone(),
                };
                (target.clone(), sources)
            })
            .collect(),
        adapter: embedding.adapter.clone().map(AdapterSetting::Named),
    }
}

/// Rebuilds the configuration that a stored index was created with, as every Narsil engine reads it back.
pub(crate) fn config_of(metadata: &IndexMetadata) -> Result<IndexConfig> {
    let mut config = IndexConfig::new(Value::Object(nest_schema(&metadata.schema)));
    config.language = Some(metadata.language.clone());
    config.bm25 = Some(Bm25Params {
        k1: Some(metadata.bm25.k1),
        b: Some(metadata.bm25.b),
        fields: metadata.bm25.fields.as_ref().map(|fields| {
            fields
                .iter()
                .map(|(path, pair)| {
                    let pair = Bm25FieldParams {
                        k1: pair.k1,
                        b: pair.b,
                    };
                    (path.clone(), pair)
                })
                .collect()
        }),
    });
    config.embedding = metadata.embedding.as_ref().map(restored_embedding);
    config.surface_forms = metadata.surface_forms;
    config.tokenizer = metadata
        .analysis
        .tokenizer
        .clone()
        .map(TokenizerSetting::Named);
    config.stop_words = match (
        &metadata.analysis.stop_words,
        &metadata.analysis.stop_word_list,
    ) {
        (Some(name), _) => Some(StopWordsSetting::Named(name.clone())),
        (None, Some(list)) => Some(StopWordsSetting::Words(StopWords::Set(
            list.iter().cloned().collect(),
        ))),
        (None, None) => None,
    };
    config.partitions = metadata
        .partition_limits
        .as_ref()
        .map(|limits| PartitionConfig {
            max_docs_per_partition: limits.max_docs_per_partition,
            max_partitions: stored_max_partitions(limits.max_partitions),
            watermark: limits.watermark,
        });
    config.default_scoring = metadata
        .default_scoring
        .as_deref()
        .and_then(ScoringMode::parse);
    config.track_positions = metadata.track_positions;
    config.text_storage = metadata.text_storage.as_deref().and_then(Storage::parse);
    config.strict = metadata.strict;
    config.required = metadata.required.clone();
    config.vector_promotion = metadata
        .vector_promotion
        .as_ref()
        .map(restored_promotion)
        .transpose()?;
    config.pattern_value_limit = metadata.pattern_value_limit;
    Ok(config)
}
