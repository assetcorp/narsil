use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::inputs::as_u32;
use crate::error::Result;
use crate::format::keyword_columns::{
    BooleanColumn, EnumColumn, GeopointColumn, PatternColumn, ValueColumn,
};
use crate::index::indexed::nested_value;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::index::tail::TailSegment;
use crate::pattern::constants::PATTERN_RUN_CODE_POINTS;
use crate::schema::CompiledSchema;
use crate::util::case_fold::append_folded;
use crate::value::Value;

/// The field columns of one merge input in that input's order, borrowed from a frozen segment or built from a tail.
pub(crate) struct InputColumns<'a> {
    pub(crate) numeric: Cow<'a, [ValueColumn]>,
    pub(crate) sizes: Cow<'a, [ValueColumn]>,
    pub(crate) boolean: Cow<'a, [BooleanColumn]>,
    pub(crate) enums: Cow<'a, [EnumColumn]>,
    pub(crate) geopoint: Cow<'a, [GeopointColumn]>,
    pub(crate) pattern: Cow<'a, [PatternColumn]>,
}

type PatternRun = [u32; PATTERN_RUN_CODE_POINTS];

/// Builds the pattern index of one field of a tail: the ordinals that hold a value, ascending, and each run of
/// the case fold of any value once, in code point order, with the ascending ordinals that hold it.
pub(crate) fn tail_pattern_column(path: &str, values: &[(u32, Value)]) -> Result<PatternColumn> {
    let mut documents: Vec<u32> = Vec::new();
    let mut ordinals_by_run: BTreeMap<PatternRun, Vec<u32>> = BTreeMap::new();
    let mut folded = Vec::new();
    let mut runs: BTreeSet<PatternRun> = BTreeSet::new();
    for (ordinal, value) in values {
        let texts: Vec<&str> = match value {
            Value::String(text) => vec![text.as_str()],
            Value::Array(elements) => elements
                .iter()
                .filter_map(|element| match element {
                    Value::String(text) => Some(text.as_str()),
                    _ => None,
                })
                .collect(),
            _ => continue,
        };
        documents.push(*ordinal);
        runs.clear();
        for text in texts {
            folded.clear();
            for point in text.chars() {
                append_folded(u32::from(point), &mut folded);
            }
            runs.extend(
                folded
                    .windows(PATTERN_RUN_CODE_POINTS)
                    .map(|window| [window[0], window[1], window[2]]),
            );
        }
        for run in &runs {
            ordinals_by_run.entry(*run).or_default().push(*ordinal);
        }
    }
    documents.sort_unstable();
    documents.dedup();
    let mut column = PatternColumn {
        field: path.to_string(),
        documents,
        runs: Vec::with_capacity(ordinals_by_run.len() * PATTERN_RUN_CODE_POINTS),
        offsets: Vec::with_capacity(ordinals_by_run.len() + 1),
        postings: Vec::new(),
    };
    column.offsets.push(0);
    for (run, mut ordinals) in ordinals_by_run {
        ordinals.sort_unstable();
        ordinals.dedup();
        column.runs.extend_from_slice(&run);
        column.postings.extend_from_slice(&ordinals);
        column
            .offsets
            .push(as_u32(column.postings.len(), "pattern postings")?);
    }
    Ok(column)
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
        .map(|(path, entries)| GeopointColumn {
            field: path.clone(),
            documents: entries.iter().map(|row| row.0).collect(),
            latitudes: entries.iter().map(|row| row.1).collect(),
            longitudes: entries.iter().map(|row| row.2).collect(),
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
