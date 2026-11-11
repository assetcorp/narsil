use crate::value::{Map, Value};

/// One value that a filter compares a field against: a number, a text, or a boolean.
#[derive(Debug, Clone, PartialEq)]
pub enum Scalar {
    /// A float64, which a filter accepts only when it is finite.
    Number(f64),
    /// A text.
    Text(String),
    /// A boolean.
    Boolean(bool),
}

impl From<Scalar> for Value {
    fn from(scalar: Scalar) -> Value {
        match scalar {
            Scalar::Number(number) => Value::Number(number),
            Scalar::Text(text) => Value::String(text),
            Scalar::Boolean(flag) => Value::Bool(flag),
        }
    }
}

impl From<f64> for Scalar {
    fn from(number: f64) -> Scalar {
        Scalar::Number(number)
    }
}

impl From<i64> for Scalar {
    fn from(number: i64) -> Scalar {
        Scalar::Number(number as f64)
    }
}

impl From<i32> for Scalar {
    fn from(number: i32) -> Scalar {
        Scalar::Number(f64::from(number))
    }
}

impl From<&str> for Scalar {
    fn from(text: &str) -> Scalar {
        Scalar::Text(text.to_string())
    }
}

impl From<String> for Scalar {
    fn from(text: String) -> Scalar {
        Scalar::Text(text)
    }
}

impl From<bool> for Scalar {
    fn from(flag: bool) -> Scalar {
        Scalar::Boolean(flag)
    }
}

/// How many edits an `eq` test on a pattern field forgives, where each edit adds, removes, or replaces one code point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tolerance {
    /// The value must equal the text exactly.
    Zero,
    /// The value may differ from the text by one edit.
    One,
    /// The value may differ from the text by up to two edits.
    Two,
    /// The engine picks the largest tolerance that the length of the text supports.
    Auto,
}

impl From<Tolerance> for Value {
    fn from(tolerance: Tolerance) -> Value {
        match tolerance {
            Tolerance::Zero => Value::Number(0.0),
            Tolerance::One => Value::Number(1.0),
            Tolerance::Two => Value::Number(2.0),
            Tolerance::Auto => Value::String("auto".to_string()),
        }
    }
}

/// The unit of a radius distance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistanceUnit {
    /// Kilometres, written `km`.
    Kilometres,
    /// International miles of 1,609.344 metres, written `mi`.
    Miles,
    /// Metres, written `m`.
    Metres,
}

impl DistanceUnit {
    /// Returns the unit as the filter grammar writes it: `km`, `mi`, or `m`.
    pub fn as_str(self) -> &'static str {
        match self {
            DistanceUnit::Kilometres => "km",
            DistanceUnit::Miles => "mi",
            DistanceUnit::Metres => "m",
        }
    }
}

/// A circle on the Earth's surface, which selects the documents whose point lies within `distance` of its centre.
#[derive(Debug, Clone, PartialEq)]
pub struct GeoRadius {
    map: Map,
}

impl GeoRadius {
    /// Returns a circle centred on `lat` and `lon`, in degrees, whose radius is `distance` in `unit`.
    pub fn new(lat: f64, lon: f64, distance: f64, unit: DistanceUnit) -> GeoRadius {
        let mut map = Map::new();
        map.insert("lat", Value::Number(lat));
        map.insert("lon", Value::Number(lon));
        map.insert("distance", Value::Number(distance));
        map.insert("unit", Value::String(unit.as_str().to_string()));
        GeoRadius { map }
    }

    /// Returns the circle set to select the documents outside it, where `outside` is true.
    pub fn outside(mut self, outside: bool) -> GeoRadius {
        self.map.insert("inside", Value::Bool(!outside));
        self
    }

    /// Returns the circle set to measure distance on the WGS-84 ellipsoid, where `high_precision` is true, in place of a sphere.
    pub fn high_precision(mut self, high_precision: bool) -> GeoRadius {
        self.map
            .insert("highPrecision", Value::Bool(high_precision));
        self
    }

    pub(super) fn into_map(self) -> Map {
        self.map
    }
}

/// A polygon on the Earth's surface, which selects the documents whose point lies inside its ring.
#[derive(Debug, Clone, PartialEq)]
pub struct GeoPolygon {
    map: Map,
}

impl GeoPolygon {
    /// Returns a polygon whose ring passes through `points`, each a latitude and a longitude in degrees.
    pub fn new(points: impl IntoIterator<Item = (f64, f64)>) -> GeoPolygon {
        let ring: Vec<Value> = points
            .into_iter()
            .map(|(lat, lon)| {
                let mut point = Map::new();
                point.insert("lat", Value::Number(lat));
                point.insert("lon", Value::Number(lon));
                Value::Object(point)
            })
            .collect();
        let mut map = Map::new();
        map.insert("points", Value::Array(ring));
        GeoPolygon { map }
    }

    /// Returns the polygon set to select the documents outside it, where `outside` is true.
    pub fn outside(mut self, outside: bool) -> GeoPolygon {
        self.map.insert("inside", Value::Bool(!outside));
        self
    }

    pub(super) fn into_map(self) -> Map {
        self.map
    }
}
