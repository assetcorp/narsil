use narsil::{HnswSettings, Map, Metric, Quantization, Storage, Value, VectorPromotion};

use super::config_refusal;
use crate::documents::constants::{MAX_HNSW_M, MIN_HNSW_M};
use crate::errors::Outcome;
use crate::script_values::{saturating_count, whole_number};

fn positive_count(raw: &Map, key: &str, message: &str) -> Outcome<Option<f64>> {
    match raw.get(key) {
        None => Ok(None),
        Some(value) => match whole_number(value).filter(|count| *count >= 1.0) {
            Some(count) => Ok(Some(count)),
            None => Err(config_refusal(message, vec![(key, value.clone())])),
        },
    }
}

fn quantization_of(raw: &Map) -> Outcome<Option<Quantization>> {
    let Some(value) = raw.get("quantization") else {
        return Ok(None);
    };
    let mode = match value.as_str() {
        Some("osq8") => Quantization::Osq8,
        Some("osq4") => Quantization::Osq4,
        Some("osq2") => Quantization::Osq2,
        Some("osq1") => Quantization::Osq1,
        Some("none") => Quantization::None,
        _ => {
            return Err(config_refusal(
                "vectorPromotion.quantization must be 'osq8', 'osq4', 'osq2', 'osq1', or 'none'",
                vec![("quantization", value.clone())],
            ));
        }
    };
    Ok(Some(mode))
}

fn storage_of(raw: &Map) -> Outcome<Option<Storage>> {
    let Some(value) = raw.get("storage") else {
        return Ok(None);
    };
    match value.as_str() {
        Some("memory") => Ok(Some(Storage::Memory)),
        Some("disk") => Ok(Some(Storage::Disk)),
        _ => Err(config_refusal(
            "vectorPromotion.storage must be 'memory' or 'disk'",
            vec![("storage", value.clone())],
        )),
    }
}

fn metric_of(raw: &Map) -> Outcome<Option<Metric>> {
    let Some(value) = raw.get("metric") else {
        return Ok(None);
    };
    match value.as_str() {
        Some("cosine") => Ok(Some(Metric::Cosine)),
        Some("dotProduct") => Ok(Some(Metric::DotProduct)),
        Some("euclidean") => Ok(Some(Metric::Euclidean)),
        _ => Err(config_refusal(
            "vectorPromotion.hnswConfig.metric must be 'cosine', 'dotProduct', or 'euclidean'",
            vec![("metric", value.clone())],
        )),
    }
}

fn graph_count(count: f64) -> u32 {
    u32::try_from(saturating_count(count)).unwrap_or(u32::MAX)
}

fn hnsw_of(raw: &Map) -> Outcome<HnswSettings> {
    let m = match raw.get("m") {
        None => None,
        Some(value) => {
            match whole_number(value).filter(|m| (MIN_HNSW_M..=MAX_HNSW_M).contains(m)) {
                Some(m) => Some(graph_count(m)),
                None => {
                    return Err(config_refusal(
                        format!(
                            "vectorPromotion.hnswConfig.m must be a whole number from {MIN_HNSW_M} to {MAX_HNSW_M}"
                        ),
                        vec![("m", value.clone())],
                    ));
                }
            }
        }
    };
    let ef_construction = positive_count(
        raw,
        "efConstruction",
        "vectorPromotion.hnswConfig.efConstruction must be a positive integer",
    )?
    .map(graph_count);
    Ok(HnswSettings {
        m,
        ef_construction,
        metric: metric_of(raw)?,
    })
}

pub(super) fn vector_promotion_of(raw: Option<&Value>) -> Outcome<Option<VectorPromotion>> {
    let Some(Value::Object(raw)) = raw else {
        return Ok(None);
    };
    let threshold = positive_count(
        raw,
        "threshold",
        "vectorPromotion.threshold must be a positive integer",
    )?
    .map(saturating_count);
    let quantization = quantization_of(raw)?;
    let storage = storage_of(raw)?;
    let hnsw = match raw.get("hnswConfig") {
        Some(Value::Object(hnsw)) => Some(hnsw_of(hnsw)?),
        _ => None,
    };
    Ok(Some(VectorPromotion {
        threshold,
        filter_threshold: raw.get("filterThreshold").and_then(Value::as_f64),
        hnsw,
        quantization,
        storage,
    }))
}
