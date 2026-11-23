use narsil::{DocumentProjection, Map, Value};

const PROTOTYPE_POLLUTION_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];
const TYPE_SEPARATOR: char = ':';
const VECTOR_TYPE_START: &str = "vector[";
const VECTOR_TYPE_END: &str = "]";

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct VectorReadSettings {
    pub(crate) schema: Value,
    pub(crate) vector_fields: Vec<Vec<String>>,
    pub(crate) return_vectors: bool,
}

fn collect_vector_fields(schema: &Map, prefix: &mut Vec<String>, fields: &mut Vec<Vec<String>>) {
    for (key, value) in schema.iter() {
        prefix.push(key.clone());
        match value {
            Value::String(field_type) => {
                let base = field_type.split(TYPE_SEPARATOR).next().unwrap_or_default();
                if base.starts_with(VECTOR_TYPE_START) && base.ends_with(VECTOR_TYPE_END) {
                    fields.push(prefix.clone());
                }
            }
            Value::Object(nested) => collect_vector_fields(nested, prefix, fields),
            _ => {}
        }
        prefix.pop();
    }
}

pub(crate) fn vector_field_segments_of(schema: &Value) -> Vec<Vec<String>> {
    let mut fields = Vec::new();
    if let Value::Object(schema) = schema {
        collect_vector_fields(schema, &mut Vec::new(), &mut fields);
    }
    fields
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ResolvedProjection {
    Full,
    Nothing,
    Fields {
        include: Option<Vec<Vec<String>>>,
        exclude: Vec<Vec<String>>,
    },
}

fn overlaps(one: &[String], other: &[String]) -> bool {
    one.iter().zip(other).all(|(left, right)| left == right)
}

fn covers(outer: &[String], inner: &[String]) -> bool {
    outer.len() <= inner.len() && overlaps(outer, inner)
}

fn split_path(path: &str) -> Vec<String> {
    path.split('.')
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect()
}

fn split_paths(paths: &[String], vector_fields: &[Vec<String>]) -> Vec<Vec<String>> {
    paths
        .iter()
        .filter_map(|path| {
            let segments = split_path(path);
            if segments.is_empty()
                || segments
                    .iter()
                    .any(|segment| PROTOTYPE_POLLUTION_KEYS.contains(&segment.as_str()))
                || vector_fields
                    .iter()
                    .any(|field| field.len() < segments.len() && covers(field, &segments))
            {
                return None;
            }
            Some(segments)
        })
        .collect()
}

fn returns_vector_field(
    field: &[String],
    vectors: Option<bool>,
    include: Option<&[Vec<String>]>,
    return_vectors: bool,
) -> bool {
    if let Some(vectors) = vectors {
        return vectors;
    }
    if include.is_some_and(|include| include.iter().any(|included| included.as_slice() == field)) {
        return true;
    }
    return_vectors
}

fn asked(paths: &Option<Vec<String>>) -> Option<&[String]> {
    paths.as_deref().filter(|paths| !paths.is_empty())
}

pub(crate) fn resolve_projection(
    projection: Option<&DocumentProjection>,
    settings: &VectorReadSettings,
) -> ResolvedProjection {
    let (include, exclude, vectors) = match projection {
        Some(DocumentProjection::None) => return ResolvedProjection::Nothing,
        None | Some(DocumentProjection::All) => (None, None, None),
        Some(DocumentProjection::Fields {
            include,
            exclude,
            vectors,
        }) => (asked(include), asked(exclude), *vectors),
    };
    let returns_every_vector = vectors.unwrap_or(settings.return_vectors);
    if include.is_none() && exclude.is_none() && returns_every_vector {
        return ResolvedProjection::Full;
    }
    let include = include.map(|paths| split_paths(paths, &settings.vector_fields));
    let mut exclude = exclude
        .map(|paths| split_paths(paths, &settings.vector_fields))
        .unwrap_or_default();
    for field in &settings.vector_fields {
        if !returns_vector_field(field, vectors, include.as_deref(), settings.return_vectors) {
            exclude.push(field.clone());
        }
    }
    if include.is_none() && exclude.is_empty() {
        return ResolvedProjection::Full;
    }
    ResolvedProjection::Fields { include, exclude }
}

pub(crate) fn projection_keeps_field(projection: &ResolvedProjection, field_path: &str) -> bool {
    match projection {
        ResolvedProjection::Full => true,
        ResolvedProjection::Nothing => false,
        ResolvedProjection::Fields { include, exclude } => {
            let path = split_path(field_path);
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

pub(crate) fn keeps_any_vector_field(
    projection: &ResolvedProjection,
    settings: &VectorReadSettings,
) -> bool {
    settings
        .vector_fields
        .iter()
        .any(|field| projection_keeps_field(projection, &field.join(".")))
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

fn omit_path(source: &mut Map, path: &[String]) {
    let Some((first, rest)) = path.split_first() else {
        return;
    };
    if rest.is_empty() {
        source.remove(first);
        return;
    }
    if let Some(Value::Object(child)) = source.get_mut(first) {
        omit_path(child, rest);
    }
}

pub(crate) fn apply_projection(document: Map, projection: &ResolvedProjection) -> Map {
    match projection {
        ResolvedProjection::Full => document,
        ResolvedProjection::Nothing => Map::new(),
        ResolvedProjection::Fields { include, exclude } => {
            let mut projected = match include {
                Some(include) => {
                    let mut kept = Map::new();
                    for path in include {
                        if let Some(value) = read_path(&document, path) {
                            write_path(&mut kept, path, value.clone());
                        }
                    }
                    kept
                }
                None => document,
            };
            for path in exclude {
                omit_path(&mut projected, path);
            }
            projected
        }
    }
}

pub(crate) fn fetch_fields_for(projection: &ResolvedProjection) -> Option<Vec<String>> {
    match projection {
        ResolvedProjection::Fields {
            include: Some(include),
            ..
        } => Some(include.iter().map(|path| path.join(".")).collect()),
        _ => None,
    }
}
