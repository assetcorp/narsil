mod compiled;
mod document;
mod field_type;

pub(crate) use compiled::CompiledSchema;
pub(crate) use document::{
    DEFAULT_PATTERN_VALUE_LIMIT, require_document_within_size_limit, validate_document,
    validate_document_strict, validate_required_fields,
};
pub(crate) use field_type::MAX_VECTOR_DIMENSION;
pub use field_type::{BaseType, FieldType, parse_field_type};

use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::{Map, Value};

const MAX_NESTING_DEPTH: usize = 4;
const MAX_TEXT_FIELDS: usize = 65_536;
const RESERVED_ROOT_FIELD: &str = "id";
const PROTOTYPE_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// One field of a flattened schema: its dotted path and its parsed type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaField {
    /// The dotted path of the field, such as `meta.author`.
    pub path: String,
    /// The parsed type of the field.
    pub field_type: FieldType,
}

fn field_name_is_valid(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn validate_fields(definition: &Map, depth: usize, prefix: &str) -> Result<Map> {
    if depth > MAX_NESTING_DEPTH {
        return Err(NarsilError::new(
            ErrorCode::SCHEMA_DEPTH_EXCEEDED,
            format!(
                "Schema nesting exceeds the maximum depth of {MAX_NESTING_DEPTH} at \"{prefix}\""
            ),
        ));
    }
    let mut canonical = Map::with_capacity(definition.len());
    for (field, type_value) in definition.iter() {
        let path = if prefix.is_empty() {
            field.clone()
        } else {
            format!("{prefix}.{field}")
        };
        if PROTOTYPE_KEYS.contains(&field.as_str()) {
            return Err(NarsilError::new(
                ErrorCode::SCHEMA_INVALID_TYPE,
                format!("Field name \"{field}\" is not allowed in a schema"),
            ));
        }
        if !field_name_is_valid(field) {
            return Err(NarsilError::new(
                ErrorCode::SCHEMA_INVALID_TYPE,
                format!(
                    "Field name \"{field}\" contains characters that are not allowed; use letters, digits, and underscores only"
                ),
            ));
        }
        if depth == 1 && field == RESERVED_ROOT_FIELD {
            return Err(NarsilError::new(
                ErrorCode::SCHEMA_INVALID_TYPE,
                format!("Field \"{field}\" is reserved and cannot be defined in a schema"),
            ));
        }
        match type_value {
            Value::Object(nested) => {
                canonical.insert(
                    field.clone(),
                    Value::Object(validate_fields(nested, depth + 1, &path)?),
                );
            }
            Value::String(type_name) => {
                let parsed = parse_field_type(type_name, &path)?;
                canonical.insert(field.clone(), Value::String(parsed.name));
            }
            other => {
                return Err(NarsilError::new(
                    ErrorCode::SCHEMA_INVALID_TYPE,
                    format!(
                        "Field \"{path}\" has an invalid type definition: {}",
                        other.to_json()
                    ),
                ));
            }
        }
    }
    Ok(canonical)
}

fn require_text_field_count(count: usize) -> Result<()> {
    if count <= MAX_TEXT_FIELDS {
        return Ok(());
    }
    Err(NarsilError::new(
        ErrorCode::SCHEMA_INVALID_TYPE,
        format!(
            "The schema declares {count} string and string[] fields, but a schema holds at most {MAX_TEXT_FIELDS}"
        ),
    ))
}

/// Checks a nested schema definition and returns it with every type name in canonical form.
pub(crate) fn validate_schema(definition: &Value) -> Result<Map> {
    let Value::Object(map) = definition else {
        return Err(NarsilError::new(
            ErrorCode::SCHEMA_INVALID_TYPE,
            "Schema must be a plain object",
        ));
    };
    if map.is_empty() {
        return Err(NarsilError::new(
            ErrorCode::SCHEMA_INVALID_TYPE,
            "Schema must define at least one field",
        ));
    }
    let canonical = validate_fields(map, 1, "")?;
    let fields = schema_fields(&canonical)?;
    require_text_field_count(
        fields
            .iter()
            .filter(|field| field.field_type.base.is_word_indexed())
            .count(),
    )?;
    Ok(canonical)
}

/// Raises `SCHEMA_INVALID_VECTOR_DIMENSION` for a vector field wider than a new index allows.
pub(crate) fn require_creatable_schema(fields: &[SchemaField]) -> Result<()> {
    for field in fields {
        if field.field_type.base == BaseType::Vector
            && field.field_type.dimension > MAX_VECTOR_DIMENSION
        {
            return Err(NarsilError::new(
                ErrorCode::SCHEMA_INVALID_VECTOR_DIMENSION,
                format!(
                    "Vector field \"{}\" has {} dimensions, but a new index takes at most {MAX_VECTOR_DIMENSION}",
                    field.path, field.field_type.dimension
                ),
            ));
        }
    }
    Ok(())
}

fn flatten_into(definition: &Map, prefix: &str, out: &mut Map) {
    for (field, type_value) in definition.iter() {
        let path = if prefix.is_empty() {
            field.clone()
        } else {
            format!("{prefix}.{field}")
        };
        match type_value {
            Value::Object(nested) => flatten_into(nested, &path, out),
            other => {
                out.insert(path, other.clone());
            }
        }
    }
}

/// Flattens a nested schema definition into a map of dotted paths to type names.
pub(crate) fn flatten_schema(definition: &Map) -> Map {
    let mut out = Map::new();
    flatten_into(definition, "", &mut out);
    out
}

fn insert_nested(level: &mut Map, path: &str, type_value: &Value) {
    let Some((head, rest)) = path.split_once('.') else {
        level.insert(path, type_value.clone());
        return;
    };
    if !matches!(level.get(head), Some(Value::Object(_))) {
        level.insert(head, Value::Object(Map::new()));
    }
    if let Some(Value::Object(next)) = level.get_mut(head) {
        insert_nested(next, rest, type_value);
    }
}

/// Rebuilds the nested definition of a flat schema, the inverse of [`flatten_schema`].
pub(crate) fn nest_schema(flat: &Map) -> Map {
    let mut root = Map::new();
    for (path, type_value) in flat.iter() {
        insert_nested(&mut root, path, type_value);
    }
    root
}

/// Parses every field of a nested schema definition, in schema order.
pub(crate) fn schema_fields(definition: &Map) -> Result<Vec<SchemaField>> {
    let flat = flatten_schema(definition);
    flat_schema_fields(&flat)
}

fn flat_schema_fields(flat: &Map) -> Result<Vec<SchemaField>> {
    let mut fields = Vec::with_capacity(flat.len());
    for (path, type_value) in flat.iter() {
        let Value::String(type_name) = type_value else {
            return Err(NarsilError::new(
                ErrorCode::SCHEMA_INVALID_TYPE,
                format!(
                    "Field \"{path}\" has an invalid type definition: {}",
                    type_value.to_json()
                ),
            ));
        };
        fields.push(SchemaField {
            path: path.clone(),
            field_type: parse_field_type(type_name, path)?,
        });
    }
    Ok(fields)
}

/// Checks the field types of a stored flat schema, as every reader of a stored schema must.
pub(crate) fn require_valid_field_types(flat: &Map) -> Result<()> {
    let fields = flat_schema_fields(flat)?;
    require_text_field_count(
        fields
            .iter()
            .filter(|field| field.field_type.base.is_word_indexed())
            .count(),
    )
}

/// Returns the paths of the `partial` fields in code point order.
pub(crate) fn partial_field_paths(fields: &[SchemaField]) -> Vec<String> {
    let mut paths: Vec<String> = fields
        .iter()
        .filter(|field| field.field_type.partial)
        .map(|field| field.path.clone())
        .collect();
    paths.sort();
    paths
}
