use crate::config::{Metric, Quantization, Storage, VectorPromotion};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;

use super::constants::{
    DEFAULT_EF_CONSTRUCTION, DEFAULT_FILTER_THRESHOLD, DEFAULT_M, DEFAULT_PROMOTION_THRESHOLD,
    DIMENSIONS_PER_ESTIMATE_UNIT, MIN_M, OSQ4_MIN_DIMENSION,
};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct VectorSettings {
    pub(crate) field_name: String,
    pub(crate) dimension: usize,
    pub(crate) metric: Metric,
    pub(crate) quantization: Quantization,
    pub(crate) storage: Storage,
    pub(crate) promotion_threshold: u64,
    pub(crate) filter_threshold: f64,
    pub(crate) m: u32,
    pub(crate) ef_construction: u32,
}

pub(crate) fn metric_code(metric: Metric) -> u32 {
    match metric {
        Metric::Cosine => ffi::NARSIL_METRIC_COSINE,
        Metric::DotProduct => ffi::NARSIL_METRIC_DOT_PRODUCT,
        Metric::Euclidean => ffi::NARSIL_METRIC_EUCLIDEAN,
    }
}

pub(crate) fn default_quantization_for(dimension: usize) -> Quantization {
    if dimension >= OSQ4_MIN_DIMENSION {
        Quantization::Osq4
    } else {
        Quantization::Osq8
    }
}

pub(crate) fn to_score(distance: f64, metric: Metric) -> f64 {
    match metric {
        Metric::Cosine => 1.0 - distance,
        Metric::DotProduct => -distance,
        Metric::Euclidean => 1.0 / (1.0 + distance),
    }
}

pub(crate) fn require_dimension(dimension: usize) -> Result<()> {
    if dimension == 0 || dimension > u32::MAX as usize {
        return Err(NarsilError::new(
            ErrorCode::VECTOR_DIMENSION_MISMATCH,
            format!("Vector dimension must be a positive integer, got {dimension}"),
        ));
    }
    Ok(())
}

impl VectorSettings {
    pub(crate) fn resolve(
        field_name: &str,
        dimension: usize,
        promotion: Option<&VectorPromotion>,
        filter_threshold: Option<f64>,
    ) -> Result<VectorSettings> {
        require_dimension(dimension)?;
        let hnsw = promotion.and_then(|found| found.hnsw);
        let threshold = filter_threshold.unwrap_or(DEFAULT_FILTER_THRESHOLD);
        Ok(VectorSettings {
            field_name: field_name.to_string(),
            dimension,
            metric: hnsw
                .and_then(|found| found.metric)
                .unwrap_or(Metric::Cosine),
            quantization: promotion
                .and_then(|found| found.quantization)
                .unwrap_or_else(|| default_quantization_for(dimension)),
            storage: promotion
                .and_then(|found| found.storage)
                .unwrap_or(Storage::Memory),
            promotion_threshold: promotion
                .and_then(|found| found.threshold)
                .unwrap_or(DEFAULT_PROMOTION_THRESHOLD),
            filter_threshold: if threshold.is_nan() {
                DEFAULT_FILTER_THRESHOLD
            } else {
                threshold.clamp(0.0, 1.0)
            },
            m: hnsw
                .and_then(|found| found.m)
                .map_or(DEFAULT_M, |m| m.max(MIN_M)),
            ef_construction: hnsw
                .and_then(|found| found.ef_construction)
                .unwrap_or(DEFAULT_EF_CONSTRUCTION)
                .max(1),
        })
    }

    pub(crate) fn bits(&self) -> u8 {
        self.quantization.bits()
    }

    pub(crate) fn metric_code(&self) -> u32 {
        metric_code(self.metric)
    }

    pub(crate) fn dimension_scale(&self) -> f64 {
        self.dimension as f64 / DIMENSIONS_PER_ESTIMATE_UNIT
    }

    pub(crate) fn reads_from_disk(&self) -> bool {
        self.storage == Storage::Disk
    }
}
