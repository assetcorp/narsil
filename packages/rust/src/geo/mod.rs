mod cells;
pub(crate) mod constants;

use self::constants::{MAX_LATITUDE_DEGREES, MAX_LONGITUDE_DEGREES};

pub(crate) use self::cells::location_code;

pub(crate) fn is_latitude(value: f64) -> bool {
    (-MAX_LATITUDE_DEGREES..=MAX_LATITUDE_DEGREES).contains(&value)
}

pub(crate) fn is_longitude(value: f64) -> bool {
    (-MAX_LONGITUDE_DEGREES..=MAX_LONGITUDE_DEGREES).contains(&value)
}
