mod bounds;
mod cells;
pub(crate) mod constants;
mod distance;
mod math;
mod polygon;
mod radius;

use self::cells::{CodeRange, covering_ranges, in_ranges};
use self::constants::{MAX_LATITUDE_DEGREES, MAX_LONGITUDE_DEGREES};
use self::polygon::{PolygonTest, polygon_boxes};
use self::radius::{RadiusTest, radius_boxes};

pub(crate) use self::cells::location_code;
pub(crate) use self::polygon::GeoPoint;

pub(crate) fn is_latitude(value: f64) -> bool {
    (-MAX_LATITUDE_DEGREES..=MAX_LATITUDE_DEGREES).contains(&value)
}

pub(crate) fn is_longitude(value: f64) -> bool {
    (-MAX_LONGITUDE_DEGREES..=MAX_LONGITUDE_DEGREES).contains(&value)
}

#[derive(Debug, Clone)]
enum ShapeTest {
    Radius(RadiusTest),
    Polygon(PolygonTest),
}

#[derive(Debug, Clone)]
pub(crate) struct GeoQuery {
    ranges: Vec<CodeRange>,
    shape: ShapeTest,
    inside: bool,
}

impl GeoQuery {
    pub(crate) fn radius(
        lat: f64,
        lon: f64,
        distance_metres: f64,
        inside: bool,
        high_precision: bool,
    ) -> GeoQuery {
        GeoQuery {
            ranges: covering_ranges(&radius_boxes(lat, lon, distance_metres)),
            shape: ShapeTest::Radius(RadiusTest::new(lat, lon, distance_metres, high_precision)),
            inside,
        }
    }

    pub(crate) fn polygon(points: &[GeoPoint], inside: bool) -> GeoQuery {
        GeoQuery {
            ranges: covering_ranges(&polygon_boxes(points)),
            shape: ShapeTest::Polygon(PolygonTest::new(points)),
            inside,
        }
    }

    pub(crate) fn within(&self, lat: f64, lon: f64) -> bool {
        if !in_ranges(&self.ranges, location_code(lat, lon)) {
            return false;
        }
        match &self.shape {
            ShapeTest::Radius(test) => test.holds(lat, lon),
            ShapeTest::Polygon(test) => test.holds(lat, lon),
        }
    }

    pub(crate) fn selects(&self, lat: f64, lon: f64) -> bool {
        self.within(lat, lon) == self.inside
    }
}
