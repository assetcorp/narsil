use super::bounds::{HalfChordOrigin, js_max, js_min, sine_square_high, sine_square_low};
use super::cells::{LocationBox, longitude_boxes};
use super::constants::{
    EARTH_RADIUS_METRES, HALF_CHORD_BOUND_MAX_SQUARE, HALF_CHORD_BOUND_RELATIVE_SLACK,
    MAX_LATITUDE_DEGREES, MAX_LONGITUDE_DEGREES, RADIUS_BAND_MAX_ANGLE_RADIANS,
    RADIUS_BAND_MIN_ANGLE_RADIANS, RADIUS_BOX_MARGIN_RADIANS, RADIUS_BOX_MARGIN_RATIO,
    RADIUS_EXACT_CHECK_BAND_RATIO, RADIUS_GEODESIC_BAND_MAX_ANGLE_RADIANS,
    RADIUS_GEODESIC_BAND_MIN_METRES, RADIUS_GEODESIC_BAND_RATIO,
    WGS84_LARGEST_CURVATURE_RADIUS_METRES, WGS84_SMALLEST_CURVATURE_RADIUS_METRES,
};
use super::distance::{
    DEGREES_TO_RADIANS, HaversineOrigin, VincentyOrigin, distance_of_chord, half_chord_of_angle,
};
use super::math::{asin, cos, sin};

pub(crate) fn radius_boxes(lat: f64, lon: f64, distance_metres: f64) -> Vec<LocationBox> {
    let angle = (distance_metres / EARTH_RADIUS_METRES) * RADIUS_BOX_MARGIN_RATIO
        + RADIUS_BOX_MARGIN_RADIANS;
    let angle_degrees = angle / DEGREES_TO_RADIANS;
    let south = lat - angle_degrees;
    let north = lat + angle_degrees;
    if angle >= std::f64::consts::PI
        || south <= -MAX_LATITUDE_DEGREES
        || north >= MAX_LATITUDE_DEGREES
    {
        return vec![LocationBox {
            south: js_max(south, -MAX_LATITUDE_DEGREES),
            north: js_min(north, MAX_LATITUDE_DEGREES),
            west: -MAX_LONGITUDE_DEGREES,
            east: MAX_LONGITUDE_DEGREES,
        }];
    }
    let spread_sine = js_min(1.0, sin(angle) / cos(lat * DEGREES_TO_RADIANS));
    let spread = asin(spread_sine) / DEGREES_TO_RADIANS;
    longitude_boxes(south, north, lon - spread, lon + spread)
}

#[derive(Debug, Clone, Copy)]
struct ExactHaversine {
    origin: HaversineOrigin,
    surely_within: f64,
    surely_beyond: f64,
    distance: f64,
}

impl ExactHaversine {
    fn new(lat: f64, lon: f64, distance: f64, angle: Option<f64>) -> ExactHaversine {
        let (surely_within, surely_beyond) = match angle {
            Some(angle) => {
                let edge = half_chord_of_angle(angle);
                (
                    edge * (1.0 - RADIUS_EXACT_CHECK_BAND_RATIO),
                    edge * (1.0 + RADIUS_EXACT_CHECK_BAND_RATIO),
                )
            }
            None => (f64::NEG_INFINITY, f64::INFINITY),
        };
        ExactHaversine {
            origin: HaversineOrigin::new(lat, lon),
            surely_within,
            surely_beyond,
            distance,
        }
    }

    fn holds(&self, lat: f64, lon: f64) -> bool {
        let half_chord = self.origin.half_chord(lat, lon);
        if half_chord < self.surely_within {
            return true;
        }
        if half_chord > self.surely_beyond {
            return false;
        }
        distance_of_chord(half_chord) <= self.distance
    }
}

#[derive(Debug, Clone, Copy)]
struct Band {
    origin: HalfChordOrigin,
    surely_within: f64,
    surely_beyond: f64,
}

impl Band {
    fn decides(&self, lat: f64, lon: f64) -> Option<bool> {
        let bounds = self.origin.bound(lat, lon)?;
        if bounds.upper < self.surely_within {
            return Some(true);
        }
        if bounds.lower > self.surely_beyond {
            return Some(false);
        }
        None
    }
}

#[derive(Debug, Clone, Copy)]
enum Exact {
    Haversine(ExactHaversine),
    Vincenty {
        origin: VincentyOrigin,
        distance: f64,
    },
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RadiusTest {
    band: Option<Band>,
    exact: Exact,
}

fn haversine_test(lat: f64, lon: f64, distance: f64) -> RadiusTest {
    let angle = distance / EARTH_RADIUS_METRES;
    if angle < RADIUS_BAND_MIN_ANGLE_RADIANS || angle > RADIUS_BAND_MAX_ANGLE_RADIANS {
        return RadiusTest {
            band: None,
            exact: Exact::Haversine(ExactHaversine::new(lat, lon, distance, None)),
        };
    }
    let exact = Exact::Haversine(ExactHaversine::new(lat, lon, distance, Some(angle)));
    let edge_square = (angle / 2.0) * (angle / 2.0);
    if edge_square > HALF_CHORD_BOUND_MAX_SQUARE {
        return RadiusTest { band: None, exact };
    }
    let band = Band {
        origin: HalfChordOrigin::new(lat, lon),
        surely_within: sine_square_low(edge_square)
            * (1.0 - RADIUS_EXACT_CHECK_BAND_RATIO)
            * (1.0 - HALF_CHORD_BOUND_RELATIVE_SLACK),
        surely_beyond: sine_square_high(edge_square)
            * (1.0 + RADIUS_EXACT_CHECK_BAND_RATIO)
            * (1.0 + HALF_CHORD_BOUND_RELATIVE_SLACK),
    };
    RadiusTest {
        band: Some(band),
        exact,
    }
}

fn vincenty_test(lat: f64, lon: f64, distance: f64) -> RadiusTest {
    let exact = Exact::Vincenty {
        origin: VincentyOrigin::new(lat, lon),
        distance,
    };
    let angle = distance / EARTH_RADIUS_METRES;
    if distance < RADIUS_GEODESIC_BAND_MIN_METRES || angle > RADIUS_GEODESIC_BAND_MAX_ANGLE_RADIANS
    {
        return RadiusTest { band: None, exact };
    }
    let nearest = (distance * (1.0 - RADIUS_GEODESIC_BAND_RATIO))
        / WGS84_LARGEST_CURVATURE_RADIUS_METRES
        / 2.0;
    let farthest = (distance * (1.0 + RADIUS_GEODESIC_BAND_RATIO))
        / WGS84_SMALLEST_CURVATURE_RADIUS_METRES
        / 2.0;
    let band = Band {
        origin: HalfChordOrigin::new(lat, lon),
        surely_within: sine_square_low(nearest * nearest) * (1.0 - HALF_CHORD_BOUND_RELATIVE_SLACK),
        surely_beyond: sine_square_high(farthest * farthest)
            * (1.0 + HALF_CHORD_BOUND_RELATIVE_SLACK),
    };
    RadiusTest {
        band: Some(band),
        exact,
    }
}

impl RadiusTest {
    pub(crate) fn new(lat: f64, lon: f64, distance: f64, high_precision: bool) -> RadiusTest {
        if high_precision {
            vincenty_test(lat, lon, distance)
        } else {
            haversine_test(lat, lon, distance)
        }
    }

    pub(crate) fn holds(&self, lat: f64, lon: f64) -> bool {
        if let Some(decided) = self.band.and_then(|band| band.decides(lat, lon)) {
            return decided;
        }
        match &self.exact {
            Exact::Haversine(exact) => exact.holds(lat, lon),
            Exact::Vincenty { origin, distance } => origin.distance(lat, lon) <= *distance,
        }
    }
}
