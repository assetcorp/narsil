use narsil::{
    AdapterSetting, EmbeddingConfig, ErrorCode, HnswSettings, IndexConfig, NarsilError,
    PartitionConfig, Quantization, Storage, SynonymRule, VectorPromotion,
};
use pyo3::prelude::*;
use pyo3::types::PyString;

use super::fields::{Fields, items_of, string_of, strings_of};
use super::query::{METRICS, SCORING_MODES, bm25_params};
use crate::callbacks::adapters::PythonEmbeddingAdapter;
use crate::callbacks::analysis::{stop_words_setting, tokenizer_setting};
use crate::errors::{config_invalid, recoded};

const STORAGES: [(&str, Storage); 2] = [("memory", Storage::Memory), ("disk", Storage::Disk)];
const QUANTIZATIONS: [(&str, Quantization); 5] = [
    ("osq8", Quantization::Osq8),
    ("osq4", Quantization::Osq4),
    ("osq2", Quantization::Osq2),
    ("osq1", Quantization::Osq1),
    ("none", Quantization::None),
];
const PARTITION_KEYS_REFUSING_NONE: [&str; 3] =
    ["maxDocsPerPartition", "maxPartitions", "watermark"];
const INDEX_KEYS_REFUSING_NONE: [&str; 4] =
    ["bm25", "textStorage", "patternValueLimit", "synonyms"];
const PROMOTION_KEYS_REFUSING_NONE: [&str; 3] = ["threshold", "quantization", "storage"];
const GRAPH_KEYS_REFUSING_NONE: [&str; 3] = ["m", "efConstruction", "metric"];

pub(crate) fn partition_config(
    value: &Bound<'_, PyAny>,
    label: &str,
) -> Result<PartitionConfig, NarsilError> {
    let mut fields = Fields::of(value, label)?;
    fields.refuse_each_none(&PARTITION_KEYS_REFUSING_NONE, ErrorCode::CONFIG_INVALID)?;
    let config = PartitionConfig {
        max_docs_per_partition: fields.whole("maxDocsPerPartition")?,
        max_partitions: fields.whole("maxPartitions")?,
        watermark: fields.number("watermark")?,
    };
    fields.finish()?;
    Ok(config)
}

fn vector_promotion(mut fields: Fields<'_>) -> Result<VectorPromotion, NarsilError> {
    fields.refuse_each_none(&PROMOTION_KEYS_REFUSING_NONE, ErrorCode::CONFIG_INVALID)?;
    let hnsw = match fields.fields("hnswConfig")? {
        None => None,
        Some(mut graph) => {
            graph.refuse_each_none(&GRAPH_KEYS_REFUSING_NONE, ErrorCode::CONFIG_INVALID)?;
            let settings = HnswSettings {
                m: graph.whole_u32("m")?,
                ef_construction: graph.whole_u32("efConstruction")?,
                metric: graph.choice("metric", &METRICS)?,
            };
            graph.finish()?;
            Some(settings)
        }
    };
    let promotion = VectorPromotion {
        threshold: fields.whole("threshold")?,
        filter_threshold: fields.number("filterThreshold")?,
        hnsw,
        quantization: fields.choice("quantization", &QUANTIZATIONS)?,
        storage: fields.choice("storage", &STORAGES)?,
    };
    fields.finish()?;
    Ok(promotion)
}

fn embedding(mut fields: Fields<'_>, label: &str) -> Result<EmbeddingConfig, NarsilError> {
    let adapter_path = fields.path("adapter");
    let adapter = match fields.get("adapter")? {
        None => None,
        Some(adapter) if adapter.cast::<PyString>().is_ok() => {
            Some(AdapterSetting::Named(string_of(&adapter, &adapter_path)?))
        }
        Some(adapter) => Some(AdapterSetting::Instance(PythonEmbeddingAdapter::wrap(
            &adapter,
            &adapter_path,
        )?)),
    };
    let mapped = fields
        .fields("fields")?
        .ok_or_else(|| config_invalid(format!("{label}.fields is required")))?;
    let mut targets = Vec::new();
    for (field, sources) in mapped.entries() {
        let field = string_of(&field, &format!("{label}.fields key"))?;
        let path = format!("{label}.fields.{field}");
        let sources = if sources.cast::<PyString>().is_ok() {
            vec![string_of(&sources, &path)?]
        } else {
            strings_of(&sources, &path)?
        };
        targets.push((field, sources));
    }
    fields.finish()?;
    Ok(EmbeddingConfig {
        fields: targets,
        adapter,
    })
}

pub(crate) fn synonym_rules(
    value: &Bound<'_, PyAny>,
    label: &str,
) -> Result<Vec<SynonymRule>, NarsilError> {
    let mut rules = Vec::new();
    for (at, rule) in items_of(value, label)?.iter().enumerate() {
        let path = format!("{label}[{at}]");
        let mut fields = Fields::of(rule, &path)?;
        let words = fields.strings("words")?;
        let word = fields.string("word")?;
        let synonyms = fields.strings("synonyms")?;
        fields.finish()?;
        rules.push(match (words, word, synonyms) {
            (Some(words), None, None) => SynonymRule::TwoWay(words),
            (None, Some(word), Some(synonyms)) => SynonymRule::OneWay { word, synonyms },
            _ => {
                return Err(config_invalid(format!(
                    "{path} must hold either \"words\" or both \"word\" and \"synonyms\""
                )));
            }
        });
    }
    Ok(rules)
}

pub(crate) fn index_config(
    value: &Bound<'_, PyAny>,
    label: &str,
) -> Result<IndexConfig, NarsilError> {
    let mut fields = Fields::of(value, label).map_err(recoded(ErrorCode::SCHEMA_INVALID_TYPE))?;
    let schema = fields.value("schema")?.ok_or_else(|| {
        NarsilError::new(
            ErrorCode::SCHEMA_INVALID_TYPE,
            format!("{label}.schema is required"),
        )
    })?;
    fields.refuse_each_none(&INDEX_KEYS_REFUSING_NONE, ErrorCode::CONFIG_INVALID)?;
    let partitions_path = fields.path("partitions");
    let bm25_path = fields.path("bm25");
    let stop_words_path = fields.path("stopWords");
    let tokenizer_path = fields.path("tokenizer");
    let embedding_path = fields.path("embedding");
    let synonyms_path = fields.path("synonyms");
    let config = IndexConfig {
        schema,
        language: fields
            .string("language")
            .map_err(recoded(ErrorCode::LANGUAGE_NOT_SUPPORTED))?,
        partitions: fields
            .get("partitions")?
            .map(|partitions| partition_config(&partitions, &partitions_path))
            .transpose()?,
        default_scoring: fields.choice("defaultScoring", &SCORING_MODES)?,
        bm25: fields
            .get("bm25")?
            .map(|bm25| bm25_params(&bm25, &bm25_path))
            .transpose()?,
        stop_words: fields
            .get("stopWords")?
            .map(|stop_words| stop_words_setting(&stop_words, &stop_words_path))
            .transpose()?,
        tokenizer: fields
            .get("tokenizer")?
            .map(|tokenizer| tokenizer_setting(&tokenizer, &tokenizer_path))
            .transpose()?,
        track_positions: fields.boolean("trackPositions")?,
        text_storage: fields.choice("textStorage", &STORAGES)?,
        vector_promotion: fields
            .fields("vectorPromotion")?
            .map(vector_promotion)
            .transpose()?,
        strict: fields.boolean("strict")?,
        embedding: fields
            .fields("embedding")
            .and_then(|embedding_fields| {
                embedding_fields
                    .map(|embedding_fields| embedding(embedding_fields, &embedding_path))
                    .transpose()
            })
            .map_err(recoded(ErrorCode::EMBEDDING_CONFIG_INVALID))?,
        required: fields
            .strings("required")
            .map_err(recoded(ErrorCode::EMBEDDING_CONFIG_INVALID))?,
        surface_forms: fields.boolean("surfaceForms")?,
        pattern_value_limit: fields.whole("patternValueLimit")?,
        synonyms: fields
            .get("synonyms")?
            .map(|rules| synonym_rules(&rules, &synonyms_path))
            .transpose()?,
    };
    fields.finish()?;
    Ok(config)
}
