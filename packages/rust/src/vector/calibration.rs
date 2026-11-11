use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::config::Metric;
use crate::error::Result;

use super::constants::{
    DRIFT_CHECK_GROWTH_FACTOR, RECALIBRATION_CHUNK_VECTORS, RECALIBRATION_DRIFT_RATIO,
};
use super::core::with_scratch;
use super::field::{Generation, Shared, Writer};

const TOTALS_PAST_DIMENSION: usize = 2;

pub(crate) struct LiveMean {
    pub(crate) centroid: Vec<f32>,
    mean: Vec<f64>,
    mean_length: f64,
    pub(crate) count: u64,
    spread: f64,
}

fn live_mean_of(totals: &[f64], dimension: usize, metric: Metric) -> Option<LiveMean> {
    let count = totals[dimension + 1];
    if count <= 0.0 {
        return None;
    }
    let mean: Vec<f64> = totals[..dimension]
        .iter()
        .map(|total| total / count)
        .collect();
    let mut mean_squares = 0.0;
    for value in &mean {
        mean_squares += value * value;
    }
    let length = mean_squares.sqrt();
    let centroid = mean
        .iter()
        .map(|&value| {
            if metric == Metric::Cosine && length != 0.0 {
                (value / length) as f32
            } else {
                value as f32
            }
        })
        .collect();
    Some(LiveMean {
        centroid,
        spread: (totals[dimension] / count - mean_squares).max(0.0).sqrt(),
        mean,
        mean_length: length,
        count: count as u64,
    })
}

pub(crate) fn measure_live(shared: &Shared, generation: &Generation) -> Result<Option<LiveMean>> {
    let dimension = shared.settings.dimension;
    if shared.settings.bits() == 0 {
        return Ok(None);
    }
    let mut totals = vec![0f64; dimension + TOTALS_PAST_DIMENSION];
    let ordinals: Vec<i32> = generation
        .live_ordinals()
        .into_iter()
        .map(|ordinal| ordinal as i32)
        .collect();
    let metric = shared.settings.metric_code();
    with_scratch(|scratch| {
        for chunk in ordinals.chunks(RECALIBRATION_CHUNK_VECTORS) {
            scratch.measure(&generation.store, metric, chunk, &mut totals)?;
        }
        Ok(())
    })?;
    Ok(live_mean_of(&totals, dimension, shared.settings.metric))
}

fn next_drift_check(calibrated_count: u64, held: u64) -> u64 {
    let mut next = calibrated_count
        .max(1)
        .saturating_mul(DRIFT_CHECK_GROWTH_FACTOR);
    while next <= held && next != u64::MAX {
        next = next.saturating_mul(DRIFT_CHECK_GROWTH_FACTOR);
    }
    next
}

fn drift_ratio(
    live: &LiveMean,
    calibrated: &[f32],
    calibrated_count: u64,
    calibrated_mean_length: Option<f64>,
    metric: Metric,
) -> f64 {
    if calibrated_count == 0 || live.count <= calibrated_count {
        return 0.0;
    }
    let scale = if metric == Metric::Cosine {
        calibrated_mean_length.unwrap_or(live.mean_length)
    } else {
        1.0
    };
    let mut squares = 0.0;
    for (mean, centre) in live.mean.iter().zip(calibrated) {
        let difference = mean - f64::from(*centre) * scale;
        squares += difference * difference;
    }
    let expected = live.spread * (1.0 / calibrated_count as f64 - 1.0 / live.count as f64).sqrt();
    if expected == 0.0 {
        return if squares == 0.0 { 0.0 } else { f64::INFINITY };
    }
    squares.sqrt() / expected
}

fn note_calibration(shared: &Shared, writer: &mut Writer, count: u64, mean_length: Option<f64>) {
    writer.calibrated_count = Some(count);
    writer.calibrated_mean_length = if shared.settings.metric == Metric::Cosine {
        mean_length
    } else {
        None
    };
    shared
        .history
        .next_drift_check_at
        .store(next_drift_check(count, count), Ordering::Release);
}

fn recode(shared: &Shared, writer: &mut Writer, centroid: &[f32]) -> Result<()> {
    let generation = Arc::clone(&writer.generation);
    let previous = &generation.store;
    let fresh = Arc::new(previous.recoded_copy());
    fresh.set_centroid(centroid);
    let coded: Vec<i32> = (0..previous.slots())
        .filter(|&ordinal| previous.has_code(ordinal) && previous.present(ordinal))
        .map(|ordinal| ordinal as i32)
        .collect();
    let metric = shared.settings.metric_code();
    with_scratch(|scratch| {
        for chunk in coded.chunks(RECALIBRATION_CHUNK_VECTORS) {
            scratch.quantise(&fresh, metric, chunk)?;
        }
        Ok(())
    })?;
    shared.publish(writer, generation.with(|parts| parts.store = fresh));
    Ok(())
}

fn calibrate_from(shared: &Shared, writer: &mut Writer, live: &LiveMean) -> Result<bool> {
    if writer.generation.store.calibrated() {
        recode(shared, writer, &live.centroid)?;
    } else {
        writer.generation.store.set_centroid(&live.centroid);
    }
    note_calibration(shared, writer, live.count, Some(live.mean_length));
    Ok(true)
}

pub(crate) fn calibrate_before_build(shared: &Shared, writer: &mut Writer) -> Result<bool> {
    if shared.settings.bits() == 0 {
        return Ok(true);
    }
    let generation = Arc::clone(&writer.generation);
    match measure_live(shared, &generation)? {
        Some(live) => calibrate_from(shared, writer, &live),
        None => Ok(false),
    }
}

pub(crate) fn recalibrate_when_drifted(
    shared: &Shared,
    writer: &mut Writer,
    held: u64,
) -> Result<bool> {
    if shared.settings.bits() == 0
        || held < shared.history.next_drift_check_at.load(Ordering::Acquire)
    {
        return Ok(false);
    }
    let generation = Arc::clone(&writer.generation);
    let Some(live) = measure_live(shared, &generation)? else {
        return Ok(false);
    };
    if generation.store.calibrated()
        && let Some(count) = writer.calibrated_count
    {
        let ratio = drift_ratio(
            &live,
            &generation.store.centroid(),
            count,
            writer.calibrated_mean_length,
            shared.settings.metric,
        );
        if ratio <= RECALIBRATION_DRIFT_RATIO {
            shared
                .history
                .next_drift_check_at
                .store(next_drift_check(count, live.count), Ordering::Release);
            return Ok(false);
        }
    }
    calibrate_from(shared, writer, &live)
}
