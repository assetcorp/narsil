use super::{
    config_invalid, describe, is_quantization_mode, is_storage_mode, number, positive_integer,
    string_list,
};
use crate::error::Result;
use crate::value::{Map, Value};

const METRICS: [&str; 3] = ["cosine", "dotProduct", "euclidean"];

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct VectorFieldMetadata {
    pub(crate) dimension: u32,
    pub(crate) metric: String,
    pub(crate) quantization: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum EmbeddingSource {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct EmbeddingMetadata {
    pub(crate) adapter: Option<String>,
    pub(crate) fields: Vec<(String, EmbeddingSource)>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct HnswSettings {
    pub(crate) m: Option<u64>,
    pub(crate) ef_construction: Option<u64>,
    pub(crate) metric: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct VectorPromotion {
    pub(crate) threshold: Option<u64>,
    pub(crate) filter_threshold: Option<f64>,
    pub(crate) hnsw: Option<HnswSettings>,
    pub(crate) quantization: Option<String>,
    pub(crate) storage: Option<String>,
}

pub(crate) fn vector_fields_from_wire(value: &Value) -> Result<Vec<(String, VectorFieldMetadata)>> {
    let Value::Object(map) = value else {
        return Err(config_invalid(
            "Index metadata holds vector_fields that is not a map",
        ));
    };
    let mut out = Vec::with_capacity(map.len());
    for (path, entry) in map.iter() {
        let entry = entry.as_object();
        let quantization = entry
            .and_then(|entry| entry.get("quantization"))
            .and_then(Value::as_str);
        let Some(quantization) = quantization.filter(|mode| is_quantization_mode(mode)) else {
            let shown = entry
                .and_then(|entry| entry.get("quantization"))
                .map_or("undefined".to_string(), describe);
            return Err(config_invalid(format!(
                "Index metadata names a vector quantization \"{shown}\" for \"{path}\" this engine does not read"
            )));
        };
        let dimension = entry
            .and_then(|entry| positive_integer(entry.get("dimension")))
            .unwrap_or(0);
        let metric = entry
            .and_then(|entry| entry.get("metric"))
            .and_then(Value::as_str)
            .unwrap_or("cosine");
        out.push((
            path.clone(),
            VectorFieldMetadata {
                dimension: u32::try_from(dimension).unwrap_or(0),
                metric: metric.to_string(),
                quantization: quantization.to_string(),
            },
        ));
    }
    Ok(out)
}

pub(crate) fn vector_fields_to_wire(fields: &[(String, VectorFieldMetadata)]) -> Value {
    let mut map = Map::new();
    for (path, field) in fields {
        let mut entry = Map::new();
        entry.insert("dimension", Value::Number(field.dimension as f64));
        entry.insert("metric", Value::String(field.metric.clone()));
        entry.insert("quantization", Value::String(field.quantization.clone()));
        map.insert(path.clone(), Value::Object(entry));
    }
    Value::Object(map)
}

pub(crate) fn embedding_from_wire(value: Option<&Value>) -> Option<EmbeddingMetadata> {
    let Value::Object(map) = value? else {
        return None;
    };
    let Value::Object(fields) = map.get("fields")? else {
        return None;
    };
    let fields = fields
        .iter()
        .filter_map(|(field, source)| match source {
            Value::String(text) => Some((field.clone(), EmbeddingSource::One(text.clone()))),
            Value::Array(_) => {
                string_list(Some(source)).map(|list| (field.clone(), EmbeddingSource::Many(list)))
            }
            _ => None,
        })
        .collect();
    Some(EmbeddingMetadata {
        adapter: map
            .get("adapter")
            .and_then(Value::as_str)
            .map(str::to_string),
        fields,
    })
}

pub(crate) fn embedding_to_wire(embedding: &EmbeddingMetadata) -> Value {
    let mut map = Map::new();
    if let Some(adapter) = &embedding.adapter {
        map.insert("adapter", Value::String(adapter.clone()));
    }
    let mut fields = Map::new();
    for (field, source) in &embedding.fields {
        let wire = match source {
            EmbeddingSource::One(text) => Value::String(text.clone()),
            EmbeddingSource::Many(list) => {
                Value::Array(list.iter().cloned().map(Value::String).collect())
            }
        };
        fields.insert(field.clone(), wire);
    }
    map.insert("fields", Value::Object(fields));
    Value::Object(map)
}

pub(crate) fn promotion_from_wire(value: Option<&Value>) -> Result<Option<VectorPromotion>> {
    let Some(Value::Object(map)) = value else {
        return Ok(None);
    };
    let hnsw = match map.get("hnsw_config") {
        Some(Value::Object(hnsw)) => {
            let settings = HnswSettings {
                m: positive_integer(hnsw.get("m")),
                ef_construction: positive_integer(hnsw.get("ef_construction")),
                metric: hnsw
                    .get("metric")
                    .and_then(Value::as_str)
                    .filter(|metric| METRICS.contains(metric))
                    .map(str::to_string),
            };
            (settings != HnswSettings::default()).then_some(settings)
        }
        _ => None,
    };
    let quantization = match map.get("quantization") {
        None => None,
        Some(Value::String(mode)) if is_quantization_mode(mode) => Some(mode.clone()),
        Some(other) => {
            return Err(config_invalid(format!(
                "Index metadata names a vector quantization \"{}\" this engine does not read",
                describe(other)
            )));
        }
    };
    let storage = match map.get("storage") {
        None => None,
        Some(Value::String(mode)) if is_storage_mode(mode) => Some(mode.clone()),
        Some(other) => {
            return Err(config_invalid(format!(
                "Index metadata names a vector storage \"{}\" this engine does not read",
                describe(other)
            )));
        }
    };
    let filter_threshold = number(map.get("filter_threshold"))
        .filter(|ratio| ratio.is_finite() && *ratio >= 0.0 && *ratio <= 1.0);
    let promotion = VectorPromotion {
        threshold: positive_integer(map.get("threshold")),
        filter_threshold,
        hnsw,
        quantization,
        storage,
    };
    Ok((promotion != VectorPromotion::default()).then_some(promotion))
}

pub(crate) fn promotion_to_wire(promotion: &VectorPromotion) -> Value {
    let mut map = Map::new();
    if let Some(threshold) = promotion.threshold {
        map.insert("threshold", Value::Number(threshold as f64));
    }
    if let Some(ratio) = promotion.filter_threshold {
        map.insert("filter_threshold", Value::Number(ratio));
    }
    if let Some(hnsw) = &promotion.hnsw {
        let mut wire = Map::new();
        if let Some(m) = hnsw.m {
            wire.insert("m", Value::Number(m as f64));
        }
        if let Some(ef) = hnsw.ef_construction {
            wire.insert("ef_construction", Value::Number(ef as f64));
        }
        if let Some(metric) = &hnsw.metric {
            wire.insert("metric", Value::String(metric.clone()));
        }
        map.insert("hnsw_config", Value::Object(wire));
    }
    if let Some(mode) = &promotion.quantization {
        map.insert("quantization", Value::String(mode.clone()));
    }
    if let Some(mode) = &promotion.storage {
        map.insert("storage", Value::String(mode.clone()));
    }
    Value::Object(map)
}
