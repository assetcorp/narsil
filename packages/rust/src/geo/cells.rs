use super::constants::{
    FULL_TURN_DEGREES, LOCATION_CODE_BITS_PER_AXIS, MAX_LATITUDE_DEGREES, MAX_LONGITUDE_DEGREES,
};

const AXIS_CELLS: u64 = 1 << LOCATION_CODE_BITS_PER_AXIS;

fn axis_cell(value: f64, lowest: f64, span: f64) -> u64 {
    let cell = (((value - lowest) / span) * AXIS_CELLS as f64).floor();
    if cell.is_nan() || cell <= 0.0 {
        return 0;
    }
    if cell >= AXIS_CELLS as f64 {
        return AXIS_CELLS - 1;
    }
    cell as u64
}

fn interleave(row: u64, column: u64, bits: u32) -> u64 {
    let mut code = 0u64;
    for bit in (0..bits).rev() {
        code = code * 4 + ((row >> bit) & 1) * 2 + ((column >> bit) & 1);
    }
    code
}

pub(crate) fn location_code(lat: f64, lon: f64) -> u64 {
    interleave(
        axis_cell(lat, -MAX_LATITUDE_DEGREES, 2.0 * MAX_LATITUDE_DEGREES),
        axis_cell(lon, -MAX_LONGITUDE_DEGREES, FULL_TURN_DEGREES),
        LOCATION_CODE_BITS_PER_AXIS,
    )
}
