use super::params::DocumentProjection;
use crate::value::{Map, Value};

const PROTOTYPE_POLLUTION_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

pub(crate) enum Projection {
    Full,
    Nothing,
    Fields {
        include: Option<Vec<Vec<String>>>,
        exclude: Vec<Vec<String>>,
    },
}

fn split_paths(paths: &[String]) -> Vec<Vec<String>> {
    paths
        .iter()
        .filter_map(|path| {
            let segments: Vec<String> = path
                .split('.')
                .filter(|segment| !segment.is_empty())
                .map(str::to_string)
                .collect();
            let usable = !segments.is_empty()
                && !segments
                    .iter()
                    .any(|segment| PROTOTYPE_POLLUTION_KEYS.contains(&segment.as_str()));
            usable.then_some(segments)
        })
        .collect()
}

fn asked(paths: &Option<Vec<String>>) -> Option<&[String]> {
    paths.as_deref().filter(|paths| !paths.is_empty())
}

pub(crate) fn resolve_projection(projection: Option<&DocumentProjection>) -> Projection {
    match projection {
        None | Some(DocumentProjection::All) => Projection::Full,
        Some(DocumentProjection::None) => Projection::Nothing,
        Some(DocumentProjection::Fields { include, exclude }) => {
            let include = asked(include);
            let exclude = asked(exclude);
            if include.is_none() && exclude.is_none() {
                return Projection::Full;
            }
            Projection::Fields {
                include: include.map(split_paths),
                exclude: exclude.map(split_paths).unwrap_or_default(),
            }
        }
    }
}

fn overlaps(one: &[String], other: &[String]) -> bool {
    one.iter().zip(other).all(|(left, right)| left == right)
}

fn covers(outer: &[String], inner: &[String]) -> bool {
    outer.len() <= inner.len() && overlaps(outer, inner)
}

pub(crate) fn projection_keeps_field(projection: &Projection, field: &str) -> bool {
    match projection {
        Projection::Full => true,
        Projection::Nothing => false,
        Projection::Fields { include, exclude } => {
            let path: Vec<String> = field
                .split('.')
                .filter(|segment| !segment.is_empty())
                .map(str::to_string)
                .collect();
            if path.is_empty() {
                return false;
            }
            if include
                .as_ref()
                .is_some_and(|include| !include.iter().any(|included| overlaps(included, &path)))
            {
                return false;
            }
            !exclude.iter().any(|excluded| covers(excluded, &path))
        }
    }
}

fn kept_entries(source: &Map, path: &mut Vec<String>, exclude: &[Vec<String>]) -> Map {
    let mut kept = Map::with_capacity(source.len());
    for (key, child) in source.iter() {
        path.push(key.clone());
        if !exclude.iter().any(|excluded| covers(excluded, path)) {
            kept.insert(key.clone(), clone_except(child, path, exclude));
        }
        path.pop();
    }
    kept
}

fn clone_except(value: &Value, path: &mut Vec<String>, exclude: &[Vec<String>]) -> Value {
    let reaches_deeper = exclude
        .iter()
        .any(|excluded| excluded.len() > path.len() && covers(path, excluded));
    match value {
        Value::Object(source) if reaches_deeper => {
            Value::Object(kept_entries(source, path, exclude))
        }
        _ => value.clone(),
    }
}

fn read_path<'d>(document: &'d Map, path: &[String]) -> Option<&'d Value> {
    let (first, rest) = path.split_first()?;
    let mut current = document.get(first)?;
    for segment in rest {
        let Value::Object(map) = current else {
            return None;
        };
        current = map.get(segment)?;
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
        let Some(Value::Object(child)) = current.get_mut(segment) else {
            return;
        };
        current = child;
    }
    current.insert(last.clone(), value);
}

pub(crate) fn project_document(document: &Map, projection: &Projection) -> Map {
    match projection {
        Projection::Full => document.clone(),
        Projection::Nothing => Map::new(),
        Projection::Fields {
            include: None,
            exclude,
        } => match exclude.is_empty() {
            true => document.clone(),
            false => kept_entries(document, &mut Vec::new(), exclude),
        },
        Projection::Fields {
            include: Some(include),
            exclude,
        } => {
            let mut projected = Map::new();
            for path in include {
                if exclude.iter().any(|excluded| covers(excluded, path)) {
                    continue;
                }
                let Some(value) = read_path(document, path) else {
                    continue;
                };
                let mut walked = path.clone();
                write_path(
                    &mut projected,
                    path,
                    clone_except(value, &mut walked, exclude),
                );
            }
            projected
        }
    }
}
