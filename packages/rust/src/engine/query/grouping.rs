use std::cmp::Ordering;
use std::collections::HashMap;

use super::constants::DEFAULT_MAX_PER_GROUP;
use super::documents::LocatedFields;
use super::gather::QueryRun;
use super::javascript::write_json_text;
use super::params::{GroupConfig, GroupReducer};
use super::ranked::{Ranked, locate_all};
use crate::error::Result;
use crate::value::{Value, number_to_text};

type GroupValues = Vec<(String, Option<Value>)>;

pub(crate) struct GroupDraft {
    pub(crate) values: GroupValues,
    pub(crate) hits: Vec<Ranked>,
    pub(crate) reduced: Option<Value>,
    pub(crate) reducer_error: Option<String>,
}

fn write_joined<'v>(out: &mut String, items: impl Iterator<Item = &'v Value>) {
    for (at, item) in items.enumerate() {
        if at > 0 {
            out.push(',');
        }
        write_key_json(out, item);
    }
}

fn write_key_json(out: &mut String, value: &Value) {
    match value {
        Value::Null | Value::Timestamp(_) => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) if number.is_finite() => out.push_str(&number_to_text(*number)),
        Value::Number(_) => out.push_str("null"),
        Value::String(text) => write_json_text(out, text),
        Value::Array(items) => {
            out.push('[');
            write_joined(out, items.iter());
            out.push(']');
        }
        Value::Bytes(bytes) => {
            out.push('{');
            for (at, byte) in bytes.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                out.push_str(&format!("\"{at}\":{byte}"));
            }
            out.push('}');
        }
        Value::Object(map) => {
            out.push('{');
            for (at, (key, item)) in map.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write_json_text(out, key);
                out.push(':');
                write_key_json(out, item);
            }
            out.push('}');
        }
    }
}

fn hits_kept_per_group(max_per_group: Option<usize>) -> usize {
    max_per_group
        .filter(|kept| *kept >= 1)
        .unwrap_or(DEFAULT_MAX_PER_GROUP)
}

fn fold_reducer<'h>(
    run: &QueryRun<'_>,
    reduce: &GroupReducer,
    hits: impl Iterator<Item = &'h Ranked>,
) -> Result<(Option<Value>, Option<String>)> {
    let mut accumulator = (reduce.initial_value)();
    for hit in hits {
        let Some(document) = run.document(&hit.id, hit.location)? else {
            continue;
        };
        match (reduce.reducer)(accumulator, &document, hit.score) {
            Ok(next) => accumulator = next,
            Err(message) => return Ok((None, Some(message))),
        }
    }
    Ok((Some(accumulator), None))
}

fn first_score(group: &GroupDraft) -> f64 {
    group.hits.first().map_or(0.0, |hit| hit.score)
}

fn first_id(group: &GroupDraft) -> &str {
    group.hits.first().map_or("", |hit| hit.id.as_str())
}

fn group_order(left: &GroupDraft, right: &GroupDraft) -> Ordering {
    let (one, other) = (first_score(left), first_score(right));
    if one != other {
        return other.partial_cmp(&one).unwrap_or(Ordering::Equal);
    }
    first_id(left).cmp(first_id(right))
}

fn group_members(
    run: &QueryRun<'_>,
    config: &GroupConfig,
    hits: &[Ranked],
) -> Result<Vec<(GroupValues, Vec<usize>)>> {
    let paths: Vec<&str> = config.fields.iter().map(String::as_str).collect();
    let fields = LocatedFields::of(
        &run.snapshots,
        hits.iter().filter_map(|hit| hit.location),
        &paths,
    )?;
    let mut slots: HashMap<String, usize> = HashMap::new();
    let mut members: Vec<(GroupValues, Vec<usize>)> = Vec::new();
    let mut key = String::new();
    for (at, hit) in hits.iter().enumerate() {
        let readers = hit
            .location
            .and_then(|location| Some((location, fields.readers(location)?)));
        key.clear();
        key.push('[');
        let mut values: Vec<Option<Value>> = Vec::with_capacity(paths.len());
        for field in 0..paths.len() {
            let value =
                readers.and_then(|(location, readers)| readers.get(field)?.get(location.ordinal));
            if field > 0 {
                key.push(',');
            }
            match &value {
                Some(value) => write_key_json(&mut key, value),
                None => key.push_str("null"),
            }
            values.push(value.map(|value| value.into_owned()));
        }
        key.push(']');
        if let Some(&slot) = slots.get(&key) {
            members[slot].1.push(at);
            continue;
        }
        let mut record: GroupValues = Vec::with_capacity(paths.len());
        for (field, value) in config.fields.iter().zip(values) {
            if !record.iter().any(|(held, _)| held == field) {
                record.push((field.clone(), value));
            }
        }
        slots.insert(key.clone(), members.len());
        members.push((record, vec![at]));
    }
    Ok(members)
}

pub(crate) fn group_hits(
    run: &QueryRun<'_>,
    config: &GroupConfig,
    hits: &mut [Ranked],
) -> Result<Vec<GroupDraft>> {
    if config.fields.is_empty() {
        return Ok(vec![GroupDraft {
            values: Vec::new(),
            hits: hits.to_vec(),
            reduced: None,
            reducer_error: None,
        }]);
    }
    locate_all(run, hits)?;
    let members = group_members(run, config, hits)?;
    let kept = hits_kept_per_group(config.max_per_group);
    let mut groups: Vec<GroupDraft> = Vec::with_capacity(members.len());
    for (values, indices) in members {
        let (reduced, reducer_error) = match &config.reduce {
            Some(reduce) => fold_reducer(run, reduce, indices.iter().map(|&at| &hits[at]))?,
            None => (None, None),
        };
        groups.push(GroupDraft {
            values,
            hits: indices
                .iter()
                .take(kept)
                .map(|&at| hits[at].clone())
                .collect(),
            reduced,
            reducer_error,
        });
    }
    groups.sort_by(group_order);
    if let Some(limit) = config.limit {
        groups.truncate(limit);
    }
    Ok(groups)
}
