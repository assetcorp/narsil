use super::payload::{Rejection, object, whole_number};
use super::types::{
    AdapterSetting, EmbeddingConfig, HnswSettings, Metric, Quantization, Storage, VectorPromotion,
};
use super::validate::{MAX_M, MIN_M};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::fields::string_list;
use crate::value::{Map, Value};

const EARLIER_RELEASE_MIN_M: f64 = 1.0;

fn config_invalid(message: &str) -> NarsilError {
    NarsilError::new(ErrorCode::CONFIG_INVALID, message)
}

fn promotion_count(raw: &Map, key: &str, message: &str) -> Result<Option<u64>> {
    whole_number(raw.get(key), message, &config_invalid)
}

fn restored_hnsw(graph: &Value, reject: Rejection<'_>) -> Result<HnswSettings> {
    let graph = object(graph, "vectorPromotion must be an object", reject)?;
    let m = match graph.get("m") {
        None => None,
        Some(Value::Number(m)) if *m == EARLIER_RELEASE_MIN_M => Some(MIN_M),
        Some(Value::Number(m)) if m.fract() == 0.0 && *m >= 0.0 && *m <= u32::MAX as f64 => {
            Some(*m as u32)
        }
        Some(_) => {
            return Err(config_invalid(&format!(
                "vectorPromotion.hnswConfig.m must be a whole number from {MIN_M} to {MAX_M}"
            )));
        }
    };
    let ef_construction = promotion_count(
        graph,
        "efConstruction",
        "vectorPromotion.hnswConfig.efConstruction must be a positive integer",
    )?
    .map(|ef| ef.min(u32::MAX as u64) as u32);
    let metric = match graph.get("metric") {
        None => None,
        Some(Value::String(name)) if Metric::parse(name).is_some() => Metric::parse(name),
        Some(_) => {
            return Err(config_invalid(
                "vectorPromotion.hnswConfig.metric must be 'cosine', 'dotProduct', or 'euclidean'",
            ));
        }
    };
    Ok(HnswSettings {
        m,
        ef_construction,
        metric,
    })
}

pub(crate) fn restored_vector_promotion(
    raw: &Value,
    reject: Rejection<'_>,
) -> Result<VectorPromotion> {
    let raw = object(raw, "vectorPromotion must be an object", reject)?;
    let hnsw = match raw.get("hnswConfig") {
        None => None,
        Some(graph) => Some(restored_hnsw(graph, reject)?),
    };
    let quantization = match raw.get("quantization") {
        None => None,
        Some(Value::String(name)) if Quantization::parse(name).is_some() => {
            Quantization::parse(name)
        }
        Some(_) => {
            return Err(config_invalid(
                "vectorPromotion.quantization must be 'osq8', 'osq4', 'osq2', 'osq1', or 'none'",
            ));
        }
    };
    let storage = match raw.get("storage") {
        None => None,
        Some(Value::String(name)) if Storage::parse(name).is_some() => Storage::parse(name),
        Some(_) => {
            return Err(config_invalid(
                "vectorPromotion.storage must be 'memory' or 'disk'",
            ));
        }
    };
    Ok(VectorPromotion {
        threshold: promotion_count(
            raw,
            "threshold",
            "vectorPromotion.threshold must be a positive integer",
        )?,
        filter_threshold: match raw.get("filterThreshold") {
            Some(Value::Number(ratio)) => Some(*ratio),
            _ => None,
        },
        hnsw,
        quantization,
        storage,
    })
}

pub(crate) fn restored_embedding(raw: &Value, reject: Rejection<'_>) -> Result<EmbeddingConfig> {
    let raw = object(raw, "embedding must be an object", reject)?;
    let adapter = match raw.get("adapter") {
        None => None,
        Some(Value::String(name)) => Some(AdapterSetting::Named(name.clone())),
        Some(_) => return Err(reject("embedding adapter must be a name")),
    };
    let Some(Value::Object(fields)) = raw.get("fields") else {
        return Err(reject("embedding fields must be an object"));
    };
    let mut mapped = Vec::with_capacity(fields.len());
    for (target, sources) in fields.iter() {
        let sources = match sources {
            Value::String(path) => vec![path.clone()],
            other => string_list(Some(other))
                .ok_or_else(|| reject("embedding fields must map vector fields to source paths"))?,
        };
        mapped.push((target.clone(), sources));
    }
    Ok(EmbeddingConfig {
        fields: mapped,
        adapter,
    })
}
