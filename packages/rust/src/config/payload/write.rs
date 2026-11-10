use crate::analysis::{Language, StopWords};
use crate::config::types::{
    AdapterSetting, Bm25Params, EmbeddingConfig, IndexConfig, PartitionConfig, StopWordsSetting,
    SynonymRule, TokenizerSetting, VectorPromotion,
};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::index_configuration::MAX_INDEX_CONFIGURATION_BYTES;
use crate::index::constants::ARRAY_POSITION_GAP;
use crate::value::{Map, Value, encode_value};

/// The facts beside the configuration that an index records in its stored configuration payload.
pub(crate) struct PayloadFacts<'a> {
    pub(crate) language: &'a str,
    pub(crate) adapter_name: Option<&'a str>,
    pub(crate) analysis_revision: Option<&'a str>,
    pub(crate) array_position_gap: Option<u32>,
    pub(crate) synonyms: Option<&'a [SynonymRule]>,
    pub(crate) analysis_generation: u64,
}

fn bm25_pair_payload(k1: Option<f64>, b: Option<f64>) -> Map {
    let mut pair = Map::new();
    if let Some(k1) = k1 {
        pair.insert("k1", Value::Number(k1));
    }
    if let Some(b) = b {
        pair.insert("b", Value::Number(b));
    }
    pair
}

pub(crate) fn bm25_payload(bm25: &Bm25Params) -> Map {
    let mut payload = bm25_pair_payload(bm25.k1, bm25.b);
    if let Some(fields) = &bm25.fields {
        let mut named = Map::new();
        for (name, pair) in fields {
            named.insert(
                name.clone(),
                Value::Object(bm25_pair_payload(pair.k1, pair.b)),
            );
        }
        payload.insert("fields", Value::Object(named));
    }
    payload
}

fn partition_payload(partitions: &PartitionConfig) -> Map {
    let mut payload = Map::new();
    if let Some(value) = partitions.max_docs_per_partition {
        payload.insert("maxDocsPerPartition", Value::Number(value as f64));
    }
    if let Some(value) = partitions.max_partitions {
        payload.insert("maxPartitions", Value::Number(value as f64));
    }
    if let Some(value) = partitions.watermark {
        payload.insert("watermark", Value::Number(value));
    }
    payload
}

fn vector_promotion_payload(promotion: &VectorPromotion) -> Map {
    let mut payload = Map::new();
    if let Some(value) = promotion.threshold {
        payload.insert("threshold", Value::Number(value as f64));
    }
    if let Some(value) = promotion.filter_threshold {
        payload.insert("filterThreshold", Value::Number(value));
    }
    if let Some(hnsw) = promotion.hnsw {
        let mut graph = Map::new();
        if let Some(m) = hnsw.m {
            graph.insert("m", Value::Number(m as f64));
        }
        if let Some(ef) = hnsw.ef_construction {
            graph.insert("efConstruction", Value::Number(ef as f64));
        }
        if let Some(metric) = hnsw.metric {
            graph.insert("metric", Value::String(metric.name().to_string()));
        }
        payload.insert("hnswConfig", Value::Object(graph));
    }
    if let Some(quantization) = promotion.quantization {
        payload.insert(
            "quantization",
            Value::String(quantization.name().to_string()),
        );
    }
    if let Some(storage) = promotion.storage {
        payload.insert("storage", Value::String(storage.name().to_string()));
    }
    payload
}

pub(crate) fn synonym_rules_payload(rules: &[SynonymRule]) -> Value {
    Value::Array(
        rules
            .iter()
            .map(|rule| {
                let mut entry = Map::new();
                match rule {
                    SynonymRule::TwoWay(words) => {
                        entry.insert("words", Value::from(words.clone()));
                    }
                    SynonymRule::OneWay { word, synonyms } => {
                        entry.insert("word", Value::String(word.clone()));
                        entry.insert("synonyms", Value::from(synonyms.clone()));
                    }
                }
                Value::Object(entry)
            })
            .collect(),
    )
}

fn embedding_payload(embedding: &EmbeddingConfig, adapter_name: Option<&str>) -> Map {
    let mut fields = Map::new();
    for (target, sources) in &embedding.fields {
        let value = if sources.len() == 1 {
            Value::String(sources[0].clone())
        } else {
            Value::from(sources.clone())
        };
        fields.insert(target.clone(), value);
    }
    let mut payload = Map::new();
    payload.insert("fields", Value::Object(fields));
    if let Some(name) = adapter_name {
        payload.insert("adapter", Value::String(name.to_string()));
    }
    payload
}

/// Refuses with `CONFIG_INVALID` a configuration whose stored form under `language` takes more MessagePack bytes
/// than an index configuration may, so that the header of a document export stays within the line length that a
/// reader accepts.
pub(crate) fn require_configuration_within_size_limit(
    config: &IndexConfig,
    language: &Language,
) -> Result<()> {
    let adapter_name = match config
        .embedding
        .as_ref()
        .and_then(|embedding| embedding.adapter.as_ref())
    {
        Some(AdapterSetting::Named(name)) => Some(name.as_str()),
        _ => None,
    };
    let facts = PayloadFacts {
        language: language.name(),
        adapter_name,
        analysis_revision: Some(language.revision()),
        array_position_gap: Some(ARRAY_POSITION_GAP),
        synonyms: None,
        analysis_generation: 0,
    };
    let bytes = encode_value(&Value::Object(configuration_payload(config, &facts)))?.len();
    if bytes <= MAX_INDEX_CONFIGURATION_BYTES {
        return Ok(());
    }
    Err(NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        format!(
            "The index configuration takes {bytes} bytes as MessagePack, but an index configuration may take at most {MAX_INDEX_CONFIGURATION_BYTES}"
        ),
    ))
}

/// Writes the stored form of an index configuration, with the keys in the order that every Narsil engine writes them.
pub(crate) fn configuration_payload(config: &IndexConfig, facts: &PayloadFacts<'_>) -> Map {
    let mut payload = Map::new();
    payload.insert("schema", config.schema.clone());
    payload.insert("language", Value::String(facts.language.to_string()));
    if let Some(revision) = facts.analysis_revision {
        payload.insert("analysisRevision", Value::String(revision.to_string()));
    }
    if let Some(gap) = facts.array_position_gap {
        payload.insert("arrayPositionGap", Value::Number(gap as f64));
    }
    if let Some(TokenizerSetting::Named(name)) = &config.tokenizer {
        payload.insert("tokenizer", Value::String(name.clone()));
    }
    match &config.stop_words {
        Some(StopWordsSetting::Named(name)) => {
            payload.insert("stopWords", Value::String(name.clone()));
        }
        Some(StopWordsSetting::Words(StopWords::Set(words))) => {
            let mut sorted: Vec<&String> = words.iter().collect();
            sorted.sort_by(|left, right| left.chars().cmp(right.chars()));
            payload.insert(
                "stopWordList",
                Value::Array(
                    sorted
                        .into_iter()
                        .map(|word| Value::String(word.clone()))
                        .collect(),
                ),
            );
        }
        _ => {}
    }
    if facts.analysis_generation > 0 {
        payload.insert(
            "analysisGeneration",
            Value::Number(facts.analysis_generation as f64),
        );
    }
    if let Some(bm25) = &config.bm25 {
        payload.insert("bm25", Value::Object(bm25_payload(bm25)));
    }
    payload.insert(
        "surfaceForms",
        Value::Bool(config.surface_forms != Some(false)),
    );
    if let Some(partitions) = &config.partitions {
        payload.insert(
            "partitionConfig",
            Value::Object(partition_payload(partitions)),
        );
    }
    if let Some(scoring) = config.default_scoring {
        payload.insert("defaultScoring", Value::String(scoring.name().to_string()));
    }
    if let Some(track) = config.track_positions {
        payload.insert("trackPositions", Value::Bool(track));
    }
    if let Some(storage) = config.text_storage {
        payload.insert("textStorage", Value::String(storage.name().to_string()));
    }
    if let Some(strict) = config.strict {
        payload.insert("strict", Value::Bool(strict));
    }
    if let Some(required) = &config.required {
        payload.insert("required", Value::from(required.clone()));
    }
    if let Some(promotion) = &config.vector_promotion {
        payload.insert(
            "vectorPromotion",
            Value::Object(vector_promotion_payload(promotion)),
        );
    }
    if let Some(limit) = config.pattern_value_limit {
        payload.insert("patternValueLimit", Value::Number(limit as f64));
    }
    if let Some(synonyms) = facts.synonyms {
        payload.insert("synonyms", synonym_rules_payload(synonyms));
    }
    if let Some(embedding) = &config.embedding {
        payload.insert(
            "embedding",
            Value::Object(embedding_payload(embedding, facts.adapter_name)),
        );
    }
    payload
}
