use super::constants::{
    FULL_TURN_DEGREES, LOCATION_CODE_BITS_PER_AXIS, MAX_COVERING_CELLS, MAX_LATITUDE_DEGREES,
    MAX_LONGITUDE_DEGREES,
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct LocationBox {
    pub(crate) south: f64,
    pub(crate) north: f64,
    pub(crate) west: f64,
    pub(crate) east: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CodeRange {
    pub(crate) from: u64,
    pub(crate) to: u64,
}

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

fn latitude_cell(lat: f64) -> u64 {
    axis_cell(lat, -MAX_LATITUDE_DEGREES, 2.0 * MAX_LATITUDE_DEGREES)
}

fn longitude_cell(lon: f64) -> u64 {
    axis_cell(lon, -MAX_LONGITUDE_DEGREES, FULL_TURN_DEGREES)
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
        latitude_cell(lat),
        longitude_cell(lon),
        LOCATION_CODE_BITS_PER_AXIS,
    )
}

fn append_box_ranges(location: &LocationBox, out: &mut Vec<CodeRange>) {
    let south = latitude_cell(location.south);
    let north = latitude_cell(location.north);
    let west = longitude_cell(location.west);
    let east = longitude_cell(location.east);
    let mut level = LOCATION_CODE_BITS_PER_AXIS;
    while level > 0 {
        let shift = LOCATION_CODE_BITS_PER_AXIS - level;
        let rows = ((north >> shift) + 1).saturating_sub(south >> shift);
        let columns = ((east >> shift) + 1).saturating_sub(west >> shift);
        if rows.saturating_mul(columns) <= MAX_COVERING_CELLS {
            break;
        }
        level -= 1;
    }
    let shift = LOCATION_CODE_BITS_PER_AXIS - level;
    let codes_per_cell = 1u64 << (2 * shift);
    for row in (south >> shift)..=(north >> shift) {
        for column in (west >> shift)..=(east >> shift) {
            let from = interleave(row, column, level) * codes_per_cell;
            out.push(CodeRange {
                from,
                to: from + codes_per_cell,
            });
        }
    }
}

pub(crate) fn covering_ranges(boxes: &[LocationBox]) -> Vec<CodeRange> {
    let mut ranges = Vec::new();
    for location in boxes {
        append_box_ranges(location, &mut ranges);
    }
    ranges.sort_by_key(|range| range.from);
    let mut merged: Vec<CodeRange> = Vec::with_capacity(ranges.len());
    for range in ranges {
        match merged.last_mut() {
            Some(last) if range.from <= last.to => last.to = last.to.max(range.to),
            _ => merged.push(range),
        }
    }
    merged
}

pub(crate) fn in_ranges(ranges: &[CodeRange], code: u64) -> bool {
    let after = ranges.partition_point(|range| range.from <= code);
    after > 0 && code < ranges[after - 1].to
}

pub(crate) fn longitude_boxes(south: f64, north: f64, west: f64, east: f64) -> Vec<LocationBox> {
    let whole = |west: f64, east: f64| LocationBox {
        south,
        north,
        west,
        east,
    };
    if east - west >= FULL_TURN_DEGREES {
        return vec![whole(-MAX_LONGITUDE_DEGREES, MAX_LONGITUDE_DEGREES)];
    }
    if west < -MAX_LONGITUDE_DEGREES {
        return vec![
            whole(west + FULL_TURN_DEGREES, MAX_LONGITUDE_DEGREES),
            whole(-MAX_LONGITUDE_DEGREES, east),
        ];
    }
    if east > MAX_LONGITUDE_DEGREES {
        return vec![
            whole(west, MAX_LONGITUDE_DEGREES),
            whole(-MAX_LONGITUDE_DEGREES, east - FULL_TURN_DEGREES),
        ];
    }
    vec![whole(west, east)]
}
