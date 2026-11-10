use super::checks::{FieldContext, finite_number, invalid, require_list_length};
use crate::error::Result;
use crate::geo::constants::{MAX_LATITUDE_DEGREES, MAX_LONGITUDE_DEGREES, MIN_POLYGON_POINTS};
use crate::geo::{is_latitude, is_longitude};
use crate::value::{Value, javascript_text, number_to_text};

const GEO_UNITS: [(&str, f64); 3] = [
    ("km", crate::geo::constants::METRES_PER_KILOMETRE),
    ("mi", crate::geo::constants::METRES_PER_MILE),
    ("m", 1.0),
];

pub(crate) fn metres_per_unit(unit: &str) -> Option<f64> {
    GEO_UNITS
        .iter()
        .find(|(name, _)| *name == unit)
        .map(|(_, metres)| *metres)
}

fn property<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(key),
        _ => None,
    }
}

fn require_flag(path: &str, operator: &str, flag: &str, value: Option<&Value>) -> Result<()> {
    match value {
        None | Some(Value::Bool(_)) => Ok(()),
        Some(_) => invalid(format!(
            "\"{operator}.{flag}\" on field \"{path}\" must be true or false"
        )),
    }
}

fn require_radius(path: &str, circle: &Value) -> Result<()> {
    if !matches!(circle, Value::Object(_) | Value::Array(_)) {
        return invalid(format!("\"radius\" on field \"{path}\" must be an object"));
    }
    for key in ["lat", "lon", "distance"] {
        if finite_number(property(circle, key)).is_none() {
            return invalid(format!(
                "\"radius.{key}\" on field \"{path}\" must be a finite number"
            ));
        }
    }
    let unit = property(circle, "unit");
    let known = matches!(unit, Some(Value::String(name)) if metres_per_unit(name).is_some());
    if !known {
        let names: Vec<&str> = GEO_UNITS.iter().map(|(name, _)| *name).collect();
        return invalid(format!(
            "\"radius.unit\" on field \"{path}\" must be one of {}, and this filter sets {}",
            names.join(", "),
            javascript_text(unit)
        ));
    }
    require_flag(path, "radius", "inside", property(circle, "inside"))?;
    require_flag(
        path,
        "radius",
        "highPrecision",
        property(circle, "highPrecision"),
    )?;
    let number = |key: &str| finite_number(property(circle, key)).unwrap_or(f64::NAN);
    let distance = number("distance");
    if distance < 0.0 {
        return invalid(format!(
            "\"radius.distance\" on field \"{path}\" must be zero or more, and this filter sets {}",
            number_to_text(distance)
        ));
    }
    let lat = number("lat");
    if !is_latitude(lat) {
        return invalid(format!(
            "\"radius.lat\" on field \"{path}\" must be from -{MAX_LATITUDE_DEGREES} to {MAX_LATITUDE_DEGREES}, and this filter sets {}",
            number_to_text(lat)
        ));
    }
    let lon = number("lon");
    if !is_longitude(lon) {
        return invalid(format!(
            "\"radius.lon\" on field \"{path}\" must be from -{MAX_LONGITUDE_DEGREES} to {MAX_LONGITUDE_DEGREES}, and this filter sets {}",
            number_to_text(lon)
        ));
    }
    Ok(())
}

fn require_polygon_ring(points: Option<&Value>) -> Result<()> {
    let points = match points {
        Some(Value::Array(points)) if points.len() >= MIN_POLYGON_POINTS => points,
        _ => {
            return invalid(format!(
                "A polygon encloses an area only with at least {MIN_POLYGON_POINTS} points"
            ));
        }
    };
    for (position, point) in points.iter().enumerate() {
        let lat = finite_number(property(point, "lat"));
        let lon = finite_number(property(point, "lon"));
        let (Some(lat), Some(lon)) = (lat, lon) else {
            return invalid(format!(
                "A polygon point carries a finite \"lat\" and \"lon\", and the point at position {position} does not"
            ));
        };
        if is_latitude(lat) && is_longitude(lon) {
            continue;
        }
        return invalid(format!(
            "A polygon point must hold a \"lat\" from -{MAX_LATITUDE_DEGREES} to {MAX_LATITUDE_DEGREES} and a \"lon\" from -{MAX_LONGITUDE_DEGREES} to {MAX_LONGITUDE_DEGREES}, while the point at position {position} holds {}, {}",
            number_to_text(lat),
            number_to_text(lon)
        ));
    }
    Ok(())
}

pub(crate) fn require_geo_operands(field: &FieldContext<'_>) -> Result<()> {
    let path = field.path;
    if let Some(circle) = field.get("radius") {
        require_radius(path, circle)?;
    }
    let Some(polygon) = field.get("polygon") else {
        return Ok(());
    };
    let Value::Object(polygon) = polygon else {
        return invalid(format!("\"polygon\" on field \"{path}\" must be an object"));
    };
    require_flag(path, "polygon", "inside", polygon.get("inside"))?;
    let points = polygon.get("points");
    if let Some(Value::Array(list)) = points {
        require_list_length(path, "polygon", list.len())?;
    }
    require_polygon_ring(points)
}
