use super::params::DocumentProjection;
use crate::engine::index::IndexState;
use crate::value::{Map, Value};

const PROTOTYPE_POLLUTION_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

pub(crate) enum Shape {
    Full,
    Nothing,
    Fields {
        include: Option<Vec<Vec<String>>>,
        exclude: Vec<Vec<String>>,
    },
}

enum ReturnedVectors {
    Every,
    Absent,
    PerField(Vec<bool>),
}

pub(crate) struct Projection {
    pub(crate) shape: Shape,
    returned_vectors: ReturnedVectors,
}

fn every_or_absent(index: &IndexState, returned: bool) -> ReturnedVectors {
    match (index.vectors.fields().is_empty(), returned) {
        (true, _) => ReturnedVectors::PerField(Vec::new()),
        (false, true) => ReturnedVectors::Every,
        (false, false) => ReturnedVectors::Absent,
    }
}

impl Projection {
    pub(crate) fn whole_documents(index: &IndexState) -> Projection {
        Projection {
            shape: Shape::Full,
            returned_vectors: every_or_absent(index, true),
        }
    }

    pub(crate) fn returns_vector(&self, at: usize) -> bool {
        match &self.returned_vectors {
            ReturnedVectors::Every => true,
            ReturnedVectors::Absent => false,
            ReturnedVectors::PerField(returned) => returned.get(at).copied().unwrap_or(false),
        }
    }

    pub(crate) fn returns_any_vector(&self) -> bool {
        match &self.returned_vectors {
            ReturnedVectors::Every => true,
            ReturnedVectors::Absent => false,
            ReturnedVectors::PerField(returned) => returned.contains(&true),
        }
    }

    pub(crate) fn leaves_out_any_vector(&self) -> bool {
        match &self.returned_vectors {
            ReturnedVectors::Every => false,
            ReturnedVectors::Absent => true,
            ReturnedVectors::PerField(returned) => returned.contains(&false),
        }
    }
}

fn split_path(path: &str) -> Vec<String> {
    path.split('.')
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect()
}

fn split_paths(paths: &[String]) -> Vec<Vec<String>> {
    paths
        .iter()
        .filter_map(|path| {
            let segments = split_path(path);
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

fn resolve_shape(projection: Option<&DocumentProjection>) -> Shape {
    match projection {
        None | Some(DocumentProjection::All) => Shape::Full,
        Some(DocumentProjection::None) => Shape::Nothing,
        Some(DocumentProjection::Fields {
            include, exclude, ..
        }) => {
            let include = asked(include);
            let exclude = asked(exclude);
            if include.is_none() && exclude.is_none() {
                return Shape::Full;
            }
            Shape::Fields {
                include: include.map(split_paths),
                exclude: exclude.map(split_paths).unwrap_or_default(),
            }
        }
    }
}

fn asked_vectors(projection: Option<&DocumentProjection>) -> Option<bool> {
    match projection {
        Some(DocumentProjection::Fields { vectors, .. }) => *vectors,
        _ => None,
    }
}

fn included_exactly(shape: &Shape, path: &[String]) -> bool {
    match shape {
        Shape::Fields {
            include: Some(include),
            ..
        } => include.iter().any(|included| included.as_slice() == path),
        _ => false,
    }
}

pub(crate) fn resolve_projection(
    projection: Option<&DocumentProjection>,
    index: &IndexState,
) -> Projection {
    let shape = resolve_shape(projection);
    let fields = index.vectors.fields();
    if fields.is_empty() || matches!(shape, Shape::Nothing) {
        return Projection {
            shape,
            returned_vectors: ReturnedVectors::PerField(Vec::new()),
        };
    }
    let asked = asked_vectors(projection);
    if let Shape::Full = shape {
        let returned = asked.unwrap_or_else(|| index.config().return_vectors == Some(true));
        return Projection {
            shape,
            returned_vectors: every_or_absent(index, returned),
        };
    }
    let mut by_setting = None;
    let per_field = fields
        .iter()
        .map(|entry| {
            let path = split_path(&entry.path);
            let returned = match asked {
                Some(asked) => asked,
                None if included_exactly(&shape, &path) => true,
                None => {
                    *by_setting.get_or_insert_with(|| index.config().return_vectors == Some(true))
                }
            };
            returned && keeps_vector_path(&shape, &path)
        })
        .collect();
    Projection {
        shape,
        returned_vectors: ReturnedVectors::PerField(per_field),
    }
}

fn overlaps(one: &[String], other: &[String]) -> bool {
    one.iter().zip(other).all(|(left, right)| left == right)
}

fn keeps_vector_path(shape: &Shape, path: &[String]) -> bool {
    if let Shape::Fields {
        include: Some(include),
        ..
    } = shape
        && !include.iter().any(|included| covers(included, path))
    {
        return false;
    }
    keeps_path(shape, path)
}

fn covers(outer: &[String], inner: &[String]) -> bool {
    outer.len() <= inner.len() && overlaps(outer, inner)
}

fn keeps_path(shape: &Shape, path: &[String]) -> bool {
    match shape {
        Shape::Full => true,
        Shape::Nothing => false,
        Shape::Fields { include, exclude } => {
            if path.is_empty() {
                return false;
            }
            if include
                .as_ref()
                .is_some_and(|include| !include.iter().any(|included| overlaps(included, path)))
            {
                return false;
            }
            !exclude.iter().any(|excluded| covers(excluded, path))
        }
    }
}

pub(crate) fn projection_keeps_field(shape: &Shape, field: &str) -> bool {
    match shape {
        Shape::Full => true,
        Shape::Nothing => false,
        Shape::Fields { .. } => keeps_path(shape, &split_path(field)),
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

pub(crate) fn project_document(document: &Map, shape: &Shape) -> Map {
    match shape {
        Shape::Full => document.clone(),
        Shape::Nothing => Map::new(),
        Shape::Fields {
            include: None,
            exclude,
        } => match exclude.is_empty() {
            true => document.clone(),
            false => kept_entries(document, &mut Vec::new(), exclude),
        },
        Shape::Fields {
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
