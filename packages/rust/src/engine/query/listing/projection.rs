use std::sync::Arc;

use crate::engine::index::IndexState;
use crate::engine::query::params::DocumentProjection;
use crate::engine::vectors::paths::set_value_at;
use crate::error::Result;
use crate::index::partition::Partition;
use crate::value::{Map, Value};

const PATH_SEPARATOR: char = '.';
const RESERVED_SEGMENTS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// A document projection after its paths are split, as the reference engine resolves one: a path that holds a
/// reserved segment, or no segment at all, drops out.
pub(crate) enum Projection {
    Full,
    Nothing,
    Fields {
        include: Option<Vec<Vec<String>>>,
        exclude: Vec<Vec<String>>,
    },
}

fn split_paths(paths: Option<&Vec<String>>) -> Vec<Vec<String>> {
    paths
        .into_iter()
        .flatten()
        .filter_map(|path| {
            let segments: Vec<String> = path
                .split(PATH_SEPARATOR)
                .filter(|segment| !segment.is_empty())
                .map(str::to_string)
                .collect();
            let reserved = segments
                .iter()
                .any(|segment| RESERVED_SEGMENTS.contains(&segment.as_str()));
            (!segments.is_empty() && !reserved).then_some(segments)
        })
        .collect()
}

fn overlaps(left: &[String], right: &[String]) -> bool {
    left.iter().zip(right).all(|(a, b)| a == b)
}

fn covers(outer: &[String], inner: &[String]) -> bool {
    outer.len() <= inner.len() && overlaps(outer, inner)
}

fn clone_except_map(map: &Map, path: &[String], exclude: &[Vec<String>]) -> Map {
    let mut kept = Map::new();
    for (key, child) in map.iter() {
        let mut child_path = path.to_vec();
        child_path.push(key.clone());
        if exclude.iter().any(|excluded| covers(excluded, &child_path)) {
            continue;
        }
        kept.insert(key.clone(), clone_except(child, &child_path, exclude));
    }
    kept
}

fn clone_except(value: &Value, path: &[String], exclude: &[Vec<String>]) -> Value {
    let reaches_deeper = exclude
        .iter()
        .any(|excluded| excluded.len() > path.len() && covers(path, excluded));
    match value {
        Value::Object(map) if reaches_deeper => Value::Object(clone_except_map(map, path, exclude)),
        other => other.clone(),
    }
}

fn read_path<'a>(document: &'a Map, path: &[String]) -> Option<&'a Value> {
    let (first, rest) = path.split_first()?;
    let mut current = document.get(first)?;
    for segment in rest {
        current = current.as_object()?.get(segment)?;
    }
    Some(current)
}

fn write_path(target: &mut Map, path: &[String], value: Value) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut current = target;
    for segment in parents {
        if !matches!(current.get(segment), Some(Value::Object(_))) {
            current.insert(segment.clone(), Value::Object(Map::new()));
        }
        current = match current.get_mut(segment) {
            Some(Value::Object(next)) => next,
            _ => return,
        };
    }
    current.insert(last.clone(), value);
}

impl Projection {
    /// Resolves a caller's projection, which keeps every field where the caller sets no path to include or exclude.
    pub(crate) fn of(projection: Option<&DocumentProjection>) -> Projection {
        let (include, exclude) = match projection {
            None | Some(DocumentProjection::All) => return Projection::Full,
            Some(DocumentProjection::None) => return Projection::Nothing,
            Some(DocumentProjection::Fields { include, exclude }) => (include, exclude),
        };
        let asked_include = include.as_ref().is_some_and(|paths| !paths.is_empty());
        let asked_exclude = exclude.as_ref().is_some_and(|paths| !paths.is_empty());
        if !asked_include && !asked_exclude {
            return Projection::Full;
        }
        Projection::Fields {
            include: asked_include.then(|| split_paths(include.as_ref())),
            exclude: split_paths(exclude.as_ref()),
        }
    }

    /// Reports whether the projection keeps any part of the field at the dotted `field_path`, so that a read skips
    /// a vector that the caller dropped.
    pub(crate) fn keeps_field(&self, field_path: &str) -> bool {
        let (include, exclude) = match self {
            Projection::Full => return true,
            Projection::Nothing => return false,
            Projection::Fields { include, exclude } => (include, exclude),
        };
        let path: Vec<String> = field_path
            .split(PATH_SEPARATOR)
            .filter(|segment| !segment.is_empty())
            .map(str::to_string)
            .collect();
        if path.is_empty() {
            return false;
        }
        if let Some(include) = include
            && !include.iter().any(|included| overlaps(included, &path))
        {
            return false;
        }
        !exclude.iter().any(|excluded| covers(excluded, &path))
    }

    fn project(&self, document: &Map) -> Map {
        match self {
            Projection::Full => document.clone(),
            Projection::Nothing => Map::new(),
            Projection::Fields {
                include: None,
                exclude,
            } => clone_except_map(document, &[], exclude),
            Projection::Fields {
                include: Some(include),
                exclude,
            } => {
                let mut projected = Map::new();
                for path in include {
                    if exclude.iter().any(|excluded| covers(excluded, path)) {
                        continue;
                    }
                    if let Some(value) = read_path(document, path) {
                        let kept = clone_except(value, path, exclude);
                        write_path(&mut projected, path, kept);
                    }
                }
                projected
            }
        }
    }
}

fn vector_value(vector: Vec<f32>) -> Value {
    Value::Array(
        vector
            .into_iter()
            .map(|element| Value::Number(f64::from(element)))
            .collect(),
    )
}

/// Returns the stored document under `id` cut down to what `projection` keeps, with each kept vector put back, or
/// `None` where a write removed the document. A projection that keeps nothing returns an empty document without
/// reading the index.
pub(crate) fn listed_document(
    index: &IndexState,
    partitions: &[Arc<Partition>],
    id: &str,
    projection: &Projection,
) -> Result<Option<Map>> {
    match projection {
        Projection::Nothing => return Ok(Some(Map::new())),
        Projection::Full => return index.full_document(partitions, id),
        Projection::Fields { .. } => {}
    }
    let (snapshots, pin) = index.published_snapshots(partitions)?;
    let Some(stored) = index.stored_document(&snapshots, id)? else {
        return Ok(None);
    };
    let mut document = projection.project(&stored);
    for entry in index.vectors.fields() {
        if projection.keeps_field(&entry.path)
            && let Some(vector) = entry.field.pinned_vector(id, pin.value())?
        {
            set_value_at(&mut document, &entry.path, vector_value(vector));
        }
    }
    Ok(Some(document))
}
