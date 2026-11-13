use narsil::{Bm25Params, HnswSettings, IndexConfig, Quantization, VectorPromotion};
use serde::Deserialize;

use crate::errors::ApiError;
use crate::respond::to_engine_value;
use crate::search::parse_metric;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateIndexBody {
    pub name: String,
    pub config: IndexConfigBody,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bm25Body {
    k1: Option<f64>,
    b: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HnswBody {
    m: Option<u32>,
    ef_construction: Option<u32>,
    metric: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VectorPromotionBody {
    threshold: Option<u64>,
    quantization: Option<String>,
    hnsw_config: Option<HnswBody>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexConfigBody {
    schema: serde_json::Value,
    language: Option<String>,
    bm25: Option<Bm25Body>,
    vector_promotion: Option<VectorPromotionBody>,
}

fn parse_quantization(name: &str) -> Result<Quantization, ApiError> {
    match name {
        "none" => Ok(Quantization::None),
        "osq8" => Ok(Quantization::Osq8),
        "osq4" => Ok(Quantization::Osq4),
        "osq2" => Ok(Quantization::Osq2),
        "osq1" => Ok(Quantization::Osq1),
        other => Err(ApiError::invalid(format!(
            "Field \"vectorPromotion.quantization\" must be none, osq8, osq4, osq2, or osq1, got \"{other}\""
        ))),
    }
}

fn promotion(body: VectorPromotionBody) -> Result<VectorPromotion, ApiError> {
    let hnsw = match body.hnsw_config {
        None => None,
        Some(settings) => Some(HnswSettings {
            m: settings.m,
            ef_construction: settings.ef_construction,
            metric: settings.metric.as_deref().map(parse_metric).transpose()?,
        }),
    };
    Ok(VectorPromotion {
        threshold: body.threshold,
        quantization: body
            .quantization
            .as_deref()
            .map(parse_quantization)
            .transpose()?,
        hnsw,
        ..VectorPromotion::default()
    })
}

impl IndexConfigBody {
    pub fn into_config(self) -> Result<IndexConfig, ApiError> {
        Ok(IndexConfig {
            schema: to_engine_value(self.schema),
            language: self.language,
            bm25: self.bm25.map(|params| Bm25Params {
                k1: params.k1,
                b: params.b,
                fields: None,
            }),
            vector_promotion: self.vector_promotion.map(promotion).transpose()?,
            ..IndexConfig::default()
        })
    }
}
