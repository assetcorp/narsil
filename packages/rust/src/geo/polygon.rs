use super::bounds::{js_max, js_min};
use super::cells::{LocationBox, longitude_boxes};
use super::constants::{
    ANTIMERIDIAN_SPAN_DEGREES, FULL_TURN_DEGREES, MAX_LONGITUDE_DEGREES, MIN_POLYGON_POINTS,
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct GeoPoint {
    pub(crate) lat: f64,
    pub(crate) lon: f64,
}

fn signed_area(polygon: &[GeoPoint]) -> f64 {
    let mut area = 0.0;
    let mut previous = polygon.len().wrapping_sub(1);
    for (at, point) in polygon.iter().enumerate() {
        let before = polygon[previous];
        area += before.lon * point.lat - point.lon * before.lat;
        previous = at;
    }
    area
}

fn crosses_antimeridian(polygon: &[GeoPoint]) -> bool {
    let mut west = f64::INFINITY;
    let mut east = f64::NEG_INFINITY;
    for point in polygon {
        if point.lon < west {
            west = point.lon;
        }
        if point.lon > east {
            east = point.lon;
        }
    }
    east - west >= ANTIMERIDIAN_SPAN_DEGREES && signed_area(polygon) < 0.0
}

fn eastward(lon: f64) -> f64 {
    if lon < 0.0 {
        lon + FULL_TURN_DEGREES
    } else {
        lon
    }
}

#[derive(Debug, Clone)]
struct LongitudeEdgeTree {
    from: Vec<usize>,
    to: Vec<usize>,
    low: Vec<f64>,
    high: Vec<f64>,
    subtree_high: Vec<f64>,
}

fn before(index: usize, count: usize) -> usize {
    if index == 0 { count - 1 } else { index - 1 }
}

impl LongitudeEdgeTree {
    fn build(lons: &[f64]) -> LongitudeEdgeTree {
        let count = lons.len();
        let mut edges: Vec<usize> = (0..count)
            .filter(|&at| lons[at] != lons[before(at, count)])
            .collect();
        let low_of = |at: usize| js_min(lons[at], lons[before(at, count)]);
        edges.sort_by(|&left, &right| {
            low_of(left)
                .partial_cmp(&low_of(right))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let size = edges.len();
        let mut tree = LongitudeEdgeTree {
            from: Vec::with_capacity(size),
            to: Vec::with_capacity(size),
            low: Vec::with_capacity(size),
            high: Vec::with_capacity(size),
            subtree_high: vec![f64::NEG_INFINITY; size],
        };
        for at in edges {
            let other = before(at, count);
            tree.from.push(at);
            tree.to.push(other);
            tree.low.push(js_min(lons[at], lons[other]));
            tree.high.push(js_max(lons[at], lons[other]));
        }
        tree.fill_subtree_high(0, size);
        tree
    }

    fn fill_subtree_high(&mut self, start: usize, end: usize) -> f64 {
        if start >= end {
            return f64::NEG_INFINITY;
        }
        let middle = (start + end) / 2;
        let left = self.fill_subtree_high(start, middle);
        let right = self.fill_subtree_high(middle + 1, end);
        let highest = js_max(js_max(self.high[middle], left), right);
        self.subtree_high[middle] = highest;
        highest
    }

    fn for_each_spanning(&self, lon: f64, visit: &mut impl FnMut(usize, usize)) {
        self.walk(0, self.from.len(), lon, visit);
    }

    fn walk(&self, start: usize, end: usize, lon: f64, visit: &mut impl FnMut(usize, usize)) {
        if start >= end {
            return;
        }
        let middle = (start + end) / 2;
        if self.subtree_high[middle] <= lon {
            return;
        }
        self.walk(start, middle, lon, visit);
        if self.low[middle] > lon {
            return;
        }
        if lon < self.high[middle] {
            visit(self.from[middle], self.to[middle]);
        }
        self.walk(middle + 1, end, lon, visit);
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PolygonTest {
    unwrap: bool,
    lats: Vec<f64>,
    lons: Vec<f64>,
    edges: Option<LongitudeEdgeTree>,
}

impl PolygonTest {
    pub(crate) fn new(polygon: &[GeoPoint]) -> PolygonTest {
        if polygon.len() < MIN_POLYGON_POINTS {
            return PolygonTest {
                unwrap: false,
                lats: Vec::new(),
                lons: Vec::new(),
                edges: None,
            };
        }
        let unwrap = crosses_antimeridian(polygon);
        let lats: Vec<f64> = polygon.iter().map(|point| point.lat).collect();
        let lons: Vec<f64> = polygon
            .iter()
            .map(|point| {
                if unwrap {
                    eastward(point.lon)
                } else {
                    point.lon
                }
            })
            .collect();
        let edges = Some(LongitudeEdgeTree::build(&lons));
        PolygonTest {
            unwrap,
            lats,
            lons,
            edges,
        }
    }

    pub(crate) fn holds(&self, lat: f64, raw_lon: f64) -> bool {
        let Some(edges) = &self.edges else {
            return false;
        };
        let lon = if self.unwrap {
            eastward(raw_lon)
        } else {
            raw_lon
        };
        let mut inside = false;
        edges.for_each_spanning(lon, &mut |i, j| {
            let intersect = self.lats[i]
                + ((self.lats[j] - self.lats[i]) / (self.lons[j] - self.lons[i]))
                    * (lon - self.lons[i]);
            if lat < intersect {
                inside = !inside;
            }
        });
        inside
    }
}

pub(crate) fn polygon_boxes(polygon: &[GeoPoint]) -> Vec<LocationBox> {
    if polygon.len() < MIN_POLYGON_POINTS {
        return Vec::new();
    }
    let unwrap = crosses_antimeridian(polygon);
    let mut south = f64::INFINITY;
    let mut north = f64::NEG_INFINITY;
    let mut west = f64::INFINITY;
    let mut east = f64::NEG_INFINITY;
    for point in polygon {
        let lon = if unwrap {
            eastward(point.lon)
        } else {
            point.lon
        };
        south = js_min(south, point.lat);
        north = js_max(north, point.lat);
        west = js_min(west, lon);
        east = js_max(east, lon);
    }
    if west >= MAX_LONGITUDE_DEGREES {
        return longitude_boxes(
            south,
            north,
            west - FULL_TURN_DEGREES,
            east - FULL_TURN_DEGREES,
        );
    }
    longitude_boxes(south, north, west, east)
}
