use super::constants::{
    COSINE_BOUND_ABSOLUTE_SLACK, HALF_CHORD_BOUND_MAX_SQUARE, HALF_CHORD_BOUND_RELATIVE_SLACK,
};
use super::distance::DEGREES_TO_RADIANS;

const COSINE_SECOND: f64 = -1.0 / 2.0;
const COSINE_FOURTH: f64 = 1.0 / 24.0;
const COSINE_SIXTH: f64 = -1.0 / 720.0;
const COSINE_EIGHTH: f64 = 1.0 / 40_320.0;
const COSINE_TENTH: f64 = -1.0 / 3_628_800.0;
const COSINE_TWELFTH: f64 = 1.0 / 479_001_600.0;
const COSINE_FOURTEENTH: f64 = -1.0 / 87_178_291_200.0;
const COSINE_SIXTEENTH: f64 = 1.0 / 20_922_789_888_000.0;
const SINE_THIRD: f64 = -1.0 / 6.0;
const SINE_FIFTH: f64 = 1.0 / 120.0;
const SINE_SEVENTH: f64 = -1.0 / 5_040.0;
const SINE_NINTH: f64 = 1.0 / 362_880.0;
const SINE_ELEVENTH: f64 = -1.0 / 39_916_800.0;
const SINE_THIRTEENTH: f64 = 1.0 / 6_227_020_800.0;
const SINE_FIFTEENTH: f64 = -1.0 / 1_307_674_368_000.0;
const SINE_SEVENTEENTH: f64 = 1.0 / 355_687_428_096_000.0;
const SINE_SQUARE_FOURTH: f64 = 1.0 / 3.0;
const SINE_SQUARE_SIXTH: f64 = 2.0 / 45.0;

#[derive(Debug, Clone, Copy)]
pub(crate) struct HalfChordOrigin {
    lat: f64,
    lon: f64,
    phi: f64,
    cosine_low: f64,
    cosine_high: f64,
    sine_low: f64,
    sine_high: f64,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct HalfChordBounds {
    pub(crate) lower: f64,
    pub(crate) upper: f64,
}

pub(crate) fn sine_square_low(square: f64) -> f64 {
    square - square * square * SINE_SQUARE_FOURTH
}

pub(crate) fn sine_square_high(square: f64) -> f64 {
    sine_square_low(square) + square * square * square * SINE_SQUARE_SIXTH
}

fn lowest(values: [f64; 4]) -> f64 {
    values[1..]
        .iter()
        .fold(values[0], |low, &value| js_min(low, value))
}

fn highest(values: [f64; 4]) -> f64 {
    values[1..]
        .iter()
        .fold(values[0], |high, &value| js_max(high, value))
}

pub(crate) fn js_min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left < right || (left == right && left.is_sign_negative()) {
        left
    } else {
        right
    }
}

pub(crate) fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left > right || (left == right && left.is_sign_positive()) {
        left
    } else {
        right
    }
}

impl HalfChordOrigin {
    pub(crate) fn new(lat: f64, lon: f64) -> HalfChordOrigin {
        let phi = lat * DEGREES_TO_RADIANS;
        let square = phi * phi;
        let square_fourth = square * square * (square * square);
        let cosine = 1.0
            + square
                * (COSINE_SECOND
                    + square
                        * (COSINE_FOURTH
                            + square
                                * (COSINE_SIXTH
                                    + square
                                        * (COSINE_EIGHTH
                                            + square
                                                * (COSINE_TENTH
                                                    + square
                                                        * (COSINE_TWELFTH
                                                            + square * COSINE_FOURTEENTH))))));
        let magnitude = phi.abs();
        let sine = magnitude
            * (1.0
                + square
                    * (SINE_THIRD
                        + square
                            * (SINE_FIFTH
                                + square
                                    * (SINE_SEVENTH
                                        + square
                                            * (SINE_NINTH
                                                + square
                                                    * (SINE_ELEVENTH
                                                        + square
                                                            * (SINE_THIRTEENTH
                                                                + square * SINE_FIFTEENTH)))))));
        let sine_high = sine
            + magnitude * square_fourth * square_fourth * SINE_SEVENTEENTH
            + COSINE_BOUND_ABSOLUTE_SLACK;
        let sine_low = sine - COSINE_BOUND_ABSOLUTE_SLACK;
        HalfChordOrigin {
            lat,
            lon,
            phi,
            cosine_low: js_max(0.0, cosine - COSINE_BOUND_ABSOLUTE_SLACK),
            cosine_high: cosine
                + square_fourth * square_fourth * COSINE_SIXTEENTH
                + COSINE_BOUND_ABSOLUTE_SLACK,
            sine_low: if phi < 0.0 { -sine_high } else { sine_low },
            sine_high: if phi < 0.0 { -sine_low } else { sine_high },
        }
    }

    pub(crate) fn bound(&self, lat: f64, lon: f64) -> Option<HalfChordBounds> {
        let half_delta_phi = ((lat - self.lat) * DEGREES_TO_RADIANS) / 2.0;
        let half_delta_lambda = ((lon - self.lon) * DEGREES_TO_RADIANS) / 2.0;
        let step = lat * DEGREES_TO_RADIANS - self.phi;
        let phi_square = half_delta_phi * half_delta_phi;
        let lambda_square = half_delta_lambda * half_delta_lambda;
        let step_square = step * step;
        let bounded = phi_square <= HALF_CHORD_BOUND_MAX_SQUARE
            && lambda_square <= HALF_CHORD_BOUND_MAX_SQUARE
            && step_square <= HALF_CHORD_BOUND_MAX_SQUARE;
        if !bounded {
            return None;
        }
        let step_cosine_low = 1.0 - step_square / 2.0;
        let step_cosine_high = step_cosine_low + (step_square * step_square) / 24.0;
        let step_sine = step - (step * step_square) / 6.0;
        let step_sine_end = step_sine + (step * step_square * step_square) / 120.0;
        let step_sine_low = js_min(step_sine, step_sine_end);
        let step_sine_high = js_max(step_sine, step_sine_end);
        let products = [
            self.sine_low * step_sine_low,
            self.sine_low * step_sine_high,
            self.sine_high * step_sine_low,
            self.sine_high * step_sine_high,
        ];
        let turn_low = lowest(products);
        let turn_high = highest(products);
        let cosine_low = js_max(
            0.0,
            self.cosine_low * step_cosine_low - turn_high - COSINE_BOUND_ABSOLUTE_SLACK,
        );
        let cosine_high =
            self.cosine_high * step_cosine_high - turn_low + COSINE_BOUND_ABSOLUTE_SLACK;
        Some(HalfChordBounds {
            lower: (sine_square_low(phi_square)
                + self.cosine_low * cosine_low * sine_square_low(lambda_square))
                * (1.0 - HALF_CHORD_BOUND_RELATIVE_SLACK),
            upper: (sine_square_high(phi_square)
                + self.cosine_high * cosine_high * sine_square_high(lambda_square))
                * (1.0 + HALF_CHORD_BOUND_RELATIVE_SLACK),
        })
    }
}
