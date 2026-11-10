use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};

use super::inputs::as_u32;
use super::pattern::tail_pattern_column;
use crate::error::Result;
use crate::format::keyword_columns::{
    BooleanColumn, EnumColumn, GeopointColumn, PatternColumn, ValueColumn,
};
use crate::index::indexed::nested_value;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::index::tail::TailSegment;
use crate::schema::CompiledSchema;
use crate::value::Value;

const LOCATION_CODE_BITS_PER_AXIS: u32 = 26;
const LOCATION_AXIS_CELLS: f64 = (1u64 << LOCATION_CODE_BITS_PER_AXIS) as f64;
const MAX_LATITUDE_DEGREES: f64 = 90.0;
const MAX_LONGITUDE_DEGREES: f64 = 180.0;
const FULL_TURN_DEGREES: f64 = 360.0;

/// The field columns of one merge input in that input's order, borrowed from a frozen segment or built from a tail.
pub(crate) struct InputColumns<'a> {
    pub(crate) numeric: Cow<'a, [ValueColumn]>,
    pub(crate) sizes: Cow<'a, [ValueColumn]>,
    pub(crate) boolean: Cow<'a, [BooleanColumn]>,
    pub(crate) enums: Cow<'a, [EnumColumn]>,
    pub(crate) geopoint: Cow<'a, [GeopointColumn]>,
    pub(crate) pattern: Cow<'a, [PatternColumn]>,
}

fn axis_cell(value: f64, lowest: f64, span: f64) -> u64 {
    let cell = (((value - lowest) / span) * LOCATION_AXIS_CELLS).floor();
    if cell.is_nan() || cell <= 0.0 {
        return 0;
    }
    if cell >= LOCATION_AXIS_CELLS {
        return (LOCATION_AXIS_CELLS as u64) - 1;
    }
    cell as u64
}

/// Returns the cell code of a geopoint, interleaving the latitude and longitude cells bit by bit, which orders the
/// rows of a geopoint column as the reference geo index orders them.
fn location_code(latitude: f64, longitude: f64) -> u64 {
    let row = axis_cell(latitude, -MAX_LATITUDE_DEGREES, 2.0 * MAX_LATITUDE_DEGREES);
    let column = axis_cell(longitude, -MAX_LONGITUDE_DEGREES, FULL_TURN_DEGREES);
    (0..LOCATION_CODE_BITS_PER_AXIS)
        .rev()
        .fold(0u64, |code, bit| {
            code * 4 + ((row >> bit) & 1) * 2 + ((column >> bit) & 1)
        })
}

/// Ranks each column path of a tail by the first live document that holds a value in it and then by schema order,
/// which is the order that the reference writer meets each column in when it builds a segment from the live
/// documents. A path that no live document holds gets no rank.
fn first_met_ranks<'t>(
    entry: &SegmentEntry,
    tail: &'t TailSegment,
    schema: &CompiledSchema,
) -> HashMap<&'t str, (usize, usize)> {
    let columns = &tail.columns;
    let mut paths: Vec<&str> = Vec::new();
    paths.extend(columns.numeric.keys().map(String::as_str));
    paths.extend(columns.sizes.keys().map(String::as_str));
    paths.extend(columns.booleans.keys().map(String::as_str));
    paths.extend(columns.enums.keys().map(String::as_str));
    paths.extend(columns.geopoints.keys().map(String::as_str));
    paths.extend(columns.patterns.keys().map(String::as_str));
    paths.sort_unstable();
    paths.dedup();
    let schema_order: HashMap<&str, usize> = schema
        .fields
        .iter()
        .enumerate()
        .map(|(at, field)| (field.path.as_str(), at))
        .collect();
    let mut ranks: HashMap<&str, (usize, usize)> = HashMap::with_capacity(paths.len());
    let mut unranked = paths;
    for (ordinal, document) in tail.documents.iter().enumerate() {
        if unranked.is_empty() {
            break;
        }
        if u32::try_from(ordinal).is_ok_and(|ordinal| entry.is_removed(ordinal)) {
            continue;
        }
        unranked.retain(|&path| {
            let held = nested_value(document, path).is_some_and(|value| !value.is_null());
            if held {
                let order = schema_order.get(path).copied().unwrap_or(usize::MAX);
                ranks.insert(path, (ordinal, order));
            }
            !held
        });
    }
    ranks
}

fn in_first_met_order<'t, T>(
    map: &'t BTreeMap<String, T>,
    ranks: &HashMap<&str, (usize, usize)>,
) -> Vec<(&'t String, &'t T)> {
    let mut entries: Vec<((usize, usize), &String, &T)> = map
        .iter()
        .filter_map(|(path, value)| Some((*ranks.get(path.as_str())?, path, value)))
        .collect();
    entries.sort_by_key(|&(rank, _, _)| rank);
    entries
        .into_iter()
        .map(|(_, path, value)| (path, value))
        .collect()
}

fn value_columns(
    map: &BTreeMap<String, Vec<(u32, f64)>>,
    ranks: &HashMap<&str, (usize, usize)>,
) -> Vec<ValueColumn> {
    in_first_met_order(map, ranks)
        .into_iter()
        .map(|(path, entries)| ValueColumn {
            field: path.clone(),
            documents: entries.iter().map(|&(ordinal, _)| ordinal).collect(),
            values: entries.iter().map(|&(_, value)| value).collect(),
        })
        .collect()
}

fn tail_columns<'a>(
    entry: &SegmentEntry,
    tail: &'a TailSegment,
    schema: &CompiledSchema,
) -> Result<InputColumns<'a>> {
    let ranks = first_met_ranks(entry, tail, schema);
    let columns = &tail.columns;
    let boolean = in_first_met_order(&columns.booleans, &ranks)
        .into_iter()
        .map(|(path, (true_documents, false_documents))| BooleanColumn {
            field: path.clone(),
            true_documents: true_documents.clone(),
            false_documents: false_documents.clone(),
        })
        .collect();
    let mut enums = Vec::with_capacity(columns.enums.len());
    for (path, values) in in_first_met_order(&columns.enums, &ranks) {
        let mut offsets = Vec::with_capacity(values.len() + 1);
        let mut documents = Vec::new();
        offsets.push(0u32);
        let mut held = Vec::with_capacity(values.len());
        for (value, ordinals) in values {
            if ordinals.iter().all(|&ordinal| entry.is_removed(ordinal)) {
                continue;
            }
            held.push(value.clone());
            documents.extend_from_slice(ordinals);
            offsets.push(as_u32(documents.len(), "enum entries")?);
        }
        enums.push(EnumColumn {
            field: path.clone(),
            values: held,
            offsets,
            documents,
        });
    }
    let geopoint = in_first_met_order(&columns.geopoints, &ranks)
        .into_iter()
        .map(|(path, entries)| {
            let mut rows: Vec<(u64, u32, f64, f64)> = entries
                .iter()
                .map(|&(ordinal, latitude, longitude)| {
                    (
                        location_code(latitude, longitude),
                        ordinal,
                        latitude,
                        longitude,
                    )
                })
                .collect();
            rows.sort_by_key(|&(code, ordinal, _, _)| (code, ordinal));
            GeopointColumn {
                field: path.clone(),
                documents: rows.iter().map(|row| row.1).collect(),
                latitudes: rows.iter().map(|row| row.2).collect(),
                longitudes: rows.iter().map(|row| row.3).collect(),
            }
        })
        .collect();
    let pattern: Result<Vec<PatternColumn>> = in_first_met_order(&columns.patterns, &ranks)
        .into_iter()
        .map(|(path, values): (&String, &Vec<(u32, Value)>)| tail_pattern_column(path, values))
        .collect();
    Ok(InputColumns {
        numeric: Cow::Owned(value_columns(&columns.numeric, &ranks)),
        sizes: Cow::Owned(value_columns(&columns.sizes, &ranks)),
        boolean: Cow::Owned(boolean),
        enums: Cow::Owned(enums),
        geopoint: Cow::Owned(geopoint),
        pattern: Cow::Owned(pattern?),
    })
}

/// Returns the field columns of `entry` in the order that the reference writer would hold them: a frozen segment's
/// as stored, and a tail's in the order that its documents first met each column.
pub(crate) fn input_columns<'a>(
    entry: &'a SegmentEntry,
    schema: &CompiledSchema,
) -> Result<InputColumns<'a>> {
    match &entry.data {
        SegmentData::Frozen(segment) => {
            let payload = &segment.payload;
            Ok(InputColumns {
                numeric: Cow::Borrowed(&payload.numeric),
                sizes: Cow::Borrowed(&payload.sizes),
                boolean: Cow::Borrowed(&payload.boolean),
                enums: Cow::Borrowed(&payload.enums),
                geopoint: Cow::Borrowed(&payload.geopoint),
                pattern: Cow::Borrowed(&payload.pattern),
            })
        }
        SegmentData::Tail(tail) => tail_columns(entry, tail, schema),
    }
}
