use narsil::{
    AdapterSetting, Bm25FieldParams, Bm25Params, IndexConfig, Map, StopWords, StopWordsSetting,
    SynonymRule, TokenizerSetting, Value, VectorPromotion, encode_msgpack,
    index_config_from_stored_settings,
};

use crate::error::{ClusterError, ClusterResult, codes};

const DEFAULT_LANGUAGE: &str = "english";

fn code_in_settings(option: &str, registration: &str) -> ClusterError {
    ClusterError::new(
        codes::CONFIG_INVALID,
        format!(
            "A node cannot serialise code into the cluster's index metadata, so register the index {option} with {registration} and pass its name"
        ),
    )
    .with_detail("option", Value::from(option))
}

fn bm25_pair(k1: Option<f64>, b: Option<f64>) -> Map {
    let mut pair = Map::new();
    if let Some(k1) = k1 {
        pair.insert("k1", Value::Number(k1));
    }
    if let Some(b) = b {
        pair.insert("b", Value::Number(b));
    }
    pair
}

fn bm25_settings(bm25: &Bm25Params) -> Map {
    let mut settings = bm25_pair(bm25.k1, bm25.b);
    if let Some(fields) = &bm25.fields {
        let mut named = Map::new();
        for (name, Bm25FieldParams { k1, b }) in fields {
            named.insert(name.clone(), Value::Object(bm25_pair(*k1, *b)));
        }
        settings.insert("fields", Value::Object(named));
    }
    settings
}

pub(super) fn stored_bm25_settings(bm25: &Bm25Params) -> Option<Map> {
    let mut settings = bm25_pair(bm25.k1, bm25.b);
    let mut named = Map::new();
    for (name, pair) in bm25.fields.iter().flatten() {
        if pair.k1.is_none() && pair.b.is_none() {
            continue;
        }
        named.insert(name.clone(), Value::Object(bm25_pair(pair.k1, pair.b)));
    }
    if !named.is_empty() {
        settings.insert("fields", Value::Object(named));
    }
    (!settings.is_empty()).then_some(settings)
}

pub(super) fn sets_field_pairs(bm25: Option<&Bm25Params>) -> bool {
    bm25.and_then(|bm25| bm25.fields.as_ref())
        .is_some_and(|fields| {
            fields
                .iter()
                .any(|(_, pair)| pair.k1.is_some() || pair.b.is_some())
        })
}

fn vector_promotion_settings(promotion: &VectorPromotion) -> Map {
    let mut settings = Map::new();
    if let Some(threshold) = promotion.threshold {
        settings.insert("threshold", Value::Number(threshold as f64));
    }
    if let Some(threshold) = promotion.filter_threshold {
        settings.insert("filterThreshold", Value::Number(threshold));
    }
    if let Some(hnsw) = promotion.hnsw {
        let mut graph = Map::new();
        if let Some(m) = hnsw.m {
            graph.insert("m", Value::Number(f64::from(m)));
        }
        if let Some(ef_construction) = hnsw.ef_construction {
            graph.insert("efConstruction", Value::Number(f64::from(ef_construction)));
        }
        if let Some(metric) = hnsw.metric {
            graph.insert("metric", Value::from(metric.name()));
        }
        settings.insert("hnswConfig", Value::Object(graph));
    }
    if let Some(quantization) = promotion.quantization {
        settings.insert("quantization", Value::from(quantization.name()));
    }
    if let Some(storage) = promotion.storage {
        settings.insert("storage", Value::from(storage.name()));
    }
    settings
}

fn analysis_settings(config: &IndexConfig, settings: &mut Map) -> ClusterResult<()> {
    match &config.tokenizer {
        None => {}
        Some(TokenizerSetting::Named(name)) => {
            settings.insert("tokenizer", Value::String(name.clone()));
        }
        Some(TokenizerSetting::Instance(_)) => {
            return Err(code_in_settings("tokenizer", "registerTokenizer"));
        }
    }
    match &config.stop_words {
        None => {}
        Some(StopWordsSetting::Named(name)) => {
            settings.insert("stopWords", Value::String(name.clone()));
        }
        Some(StopWordsSetting::Words(StopWords::Set(words))) => {
            let mut list: Vec<String> = words.iter().cloned().collect();
            list.sort();
            settings.insert(
                "stopWordList",
                Value::Array(list.into_iter().map(Value::String).collect()),
            );
        }
        Some(StopWordsSetting::Words(StopWords::Function(_))) => {
            return Err(code_in_settings("stop words", "registerStopWords"));
        }
    }
    if let Some(fold_marks) = config.fold_marks {
        settings.insert("foldMarks", Value::Bool(fold_marks));
    }
    Ok(())
}

fn embedding_settings(config: &IndexConfig) -> ClusterResult<Option<Map>> {
    let Some(embedding) = &config.embedding else {
        return Ok(None);
    };
    let mut fields = Map::new();
    for (target, sources) in &embedding.fields {
        let value = match sources.as_slice() {
            [source] => Value::String(source.clone()),
            _ => Value::Array(sources.iter().cloned().map(Value::String).collect()),
        };
        fields.insert(target.clone(), value);
    }
    let mut settings = Map::new();
    settings.insert("fields", Value::Object(fields));
    match &embedding.adapter {
        None => {}
        Some(AdapterSetting::Named(name)) => {
            settings.insert("adapter", Value::String(name.clone()));
        }
        Some(AdapterSetting::Instance(_)) => {
            return Err(code_in_settings(
                "embedding adapter",
                "registerEmbeddingAdapter",
            ));
        }
    }
    Ok(Some(settings))
}

fn partition_limits(config: &IndexConfig) -> Option<Map> {
    let partitions = config.partitions.as_ref()?;
    let mut limits = Map::new();
    if let Some(limit) = partitions.max_docs_per_partition {
        limits.insert("maxDocsPerPartition", Value::Number(limit as f64));
    }
    if let Some(watermark) = partitions.watermark {
        limits.insert("watermark", Value::Number(watermark));
    }
    (!limits.is_empty()).then_some(limits)
}

fn optional_flag(settings: &mut Map, key: &str, flag: Option<bool>) {
    if let Some(flag) = flag {
        settings.insert(key, Value::Bool(flag));
    }
}

pub(super) fn index_settings_of(config: &IndexConfig) -> ClusterResult<Map> {
    let mut settings = Map::new();
    let language = config.language.as_deref().unwrap_or(DEFAULT_LANGUAGE);
    settings.insert("language", Value::from(language));
    analysis_settings(config, &mut settings)?;
    if let Some(bm25) = &config.bm25 {
        settings.insert("bm25", Value::Object(bm25_settings(bm25)));
    }
    optional_flag(&mut settings, "surfaceForms", config.surface_forms);
    if let Some(scoring) = config.default_scoring {
        settings.insert("defaultScoring", Value::from(scoring.name()));
    }
    optional_flag(&mut settings, "trackPositions", config.track_positions);
    if let Some(storage) = config.text_storage {
        settings.insert("textStorage", Value::from(storage.name()));
    }
    optional_flag(&mut settings, "strict", config.strict);
    optional_flag(&mut settings, "returnVectors", config.return_vectors);
    if let Some(required) = &config.required {
        settings.insert(
            "required",
            Value::Array(required.iter().cloned().map(Value::String).collect()),
        );
    }
    if let Some(promotion) = &config.vector_promotion {
        settings.insert(
            "vectorPromotion",
            Value::Object(vector_promotion_settings(promotion)),
        );
    }
    if let Some(limit) = config.pattern_value_limit {
        settings.insert("patternValueLimit", Value::Number(limit as f64));
    }
    if let Some(limits) = partition_limits(config) {
        settings.insert("partitionConfig", Value::Object(limits));
    }
    if let Some(embedding) = embedding_settings(config)? {
        settings.insert("embedding", Value::Object(embedding));
    }
    index_config_from_stored_settings(config.schema.clone(), &settings)
        .map_err(ClusterError::from)?;
    Ok(settings)
}

pub(super) fn encoded_synonym_rules(config: &IndexConfig) -> ClusterResult<Option<Vec<u8>>> {
    encoded_rules(config.synonyms.as_deref().unwrap_or_default())
}

pub(super) fn encoded_rules(rules: &[SynonymRule]) -> ClusterResult<Option<Vec<u8>>> {
    if rules.is_empty() {
        return Ok(None);
    }
    let encoded: Vec<Value> = rules
        .iter()
        .map(|rule| {
            let mut entry = Map::new();
            match rule {
                SynonymRule::TwoWay(words) => {
                    entry.insert(
                        "words",
                        Value::Array(words.iter().cloned().map(Value::String).collect()),
                    );
                }
                SynonymRule::OneWay { word, synonyms } => {
                    entry.insert("word", Value::String(word.clone()));
                    entry.insert(
                        "synonyms",
                        Value::Array(synonyms.iter().cloned().map(Value::String).collect()),
                    );
                }
            }
            Value::Object(entry)
        })
        .collect();
    Ok(Some(
        encode_msgpack(&Value::Array(encoded)).map_err(ClusterError::from)?,
    ))
}
