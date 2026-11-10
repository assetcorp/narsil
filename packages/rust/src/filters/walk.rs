use std::borrow::Cow;

use super::checks::{
    FieldContext, invalid, require_list_length, require_range_operands, require_value_operands,
};
use super::constants::{FILTER_OPERAND_COPY_DEPTH, MAX_FILTER_DEPTH, MAX_FILTER_TESTS};
use super::geo_checks::require_geo_operands;
use super::list_checks::{
    require_element_operands, require_presence_operands, require_size_operands,
    require_whole_value_index,
};
use super::pattern_checks::require_pattern_operands;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::schema::CompiledSchema;
use crate::value::{Map, Value};

const EXPRESSION_KEYS: [&str; 4] = ["fields", "and", "or", "not"];

pub(crate) const FIELD_FILTER_OPERATORS: [&str; 25] = [
    "eq",
    "ne",
    "gt",
    "lt",
    "gte",
    "lte",
    "between",
    "in",
    "nin",
    "startsWith",
    "endsWith",
    "contains",
    "wildcard",
    "regex",
    "caseFold",
    "tolerance",
    "containsAll",
    "matchesAny",
    "size",
    "exists",
    "notExists",
    "isEmpty",
    "isNotEmpty",
    "radius",
    "polygon",
];

const RANGE_CHECK: u8 = 1;
const VALUE_CHECK: u8 = 1 << 1;
const WHOLE_VALUE_CHECK: u8 = 1 << 2;
const PRESENCE_CHECK: u8 = 1 << 3;
const ELEMENT_CHECK: u8 = 1 << 4;
const SIZE_CHECK: u8 = 1 << 5;
const PATTERN_CHECK: u8 = 1 << 6;
const GEO_CHECK: u8 = 1 << 7;

type OperandCheck = fn(&FieldContext<'_>) -> Result<()>;

const OPERAND_CHECKS: [OperandCheck; 8] = [
    require_range_operands,
    require_value_operands,
    require_whole_value_index,
    require_presence_operands,
    require_element_operands,
    require_size_operands,
    require_pattern_operands,
    require_geo_operands,
];

fn checks_of(operator: &str) -> u8 {
    match operator {
        "gt" | "lt" | "gte" | "lte" | "between" => RANGE_CHECK,
        "eq" | "ne" | "in" | "nin" | "startsWith" | "endsWith" => {
            VALUE_CHECK | WHOLE_VALUE_CHECK | PATTERN_CHECK
        }
        "radius" | "polygon" => VALUE_CHECK | GEO_CHECK,
        "matchesAny" | "containsAll" => WHOLE_VALUE_CHECK | ELEMENT_CHECK | PATTERN_CHECK,
        "exists" | "notExists" | "isEmpty" | "isNotEmpty" => PRESENCE_CHECK,
        "size" => SIZE_CHECK,
        "contains" | "caseFold" | "tolerance" | "wildcard" | "regex" => PATTERN_CHECK,
        _ => 0,
    }
}

struct UnknownKey {
    message: String,
}

struct FilterWalk<'s> {
    schema: &'s CompiledSchema,
    tests: usize,
    unknown_key: Option<UnknownKey>,
}

fn invalid_shape<T>(message: impl Into<String>) -> Result<T> {
    invalid(message)
}

pub(crate) fn undeclared_filter_field(field: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::SEARCH_INVALID_FIELD,
        format!(
            "The schema declares no field \"{field}\", while the engine answers a filter only from the indexes that it keeps for declared fields. Declare the field in the schema of a new index to filter by it"
        ),
    )
}

pub(crate) fn record_of(value: &Value) -> Option<Cow<'_, Map>> {
    match value {
        Value::Object(map) => Some(Cow::Borrowed(map)),
        Value::Bytes(bytes) => Some(Cow::Owned(byte_record(bytes))),
        Value::Timestamp(_) => Some(Cow::Owned(Map::new())),
        _ => None,
    }
}

fn byte_record(bytes: &[u8]) -> Map {
    let mut record = Map::with_capacity(bytes.len());
    for (at, byte) in bytes.iter().enumerate() {
        record.insert(at.to_string(), Value::Number(f64::from(*byte)));
    }
    record
}

fn count_tests(walk: &mut FilterWalk<'_>, tests: usize) -> Result<()> {
    walk.tests += tests;
    if walk.tests > MAX_FILTER_TESTS {
        return invalid_shape(format!(
            "A filter holds at most {MAX_FILTER_TESTS} tests across all of its fields and nested expressions"
        ));
    }
    Ok(())
}

fn tests_of_operator(operator: &str, operand: &Value) -> usize {
    match operator {
        "caseFold" | "tolerance" => 0,
        "size" => match operand {
            Value::Object(comparison) => comparison.len().max(1),
            _ => 1,
        },
        _ => 1,
    }
}

fn owned_operand_of(value: &Value, path: &str, operator: &str, depth: usize) -> Result<Value> {
    if depth > FILTER_OPERAND_COPY_DEPTH {
        return Ok(value.clone());
    }
    match value {
        Value::Array(items) => {
            require_list_length(path, operator, items.len())?;
            let mut owned = Vec::with_capacity(items.len());
            for item in items {
                owned.push(owned_operand_of(item, path, operator, depth + 1)?);
            }
            Ok(Value::Array(owned))
        }
        Value::Object(_) | Value::Bytes(_) | Value::Timestamp(_) => {
            let record = record_of(value).unwrap_or_default();
            let mut owned = Map::with_capacity(record.len());
            for (key, item) in record.iter() {
                owned.insert(
                    key.clone(),
                    owned_operand_of(item, path, operator, depth + 1)?,
                );
            }
            Ok(Value::Object(owned))
        }
        other => Ok(other.clone()),
    }
}

fn require_valid_field_tests(field: &FieldContext<'_>, walk: &mut FilterWalk<'_>) -> Result<()> {
    let mut wanted = 0u8;
    let mut tests = 0;
    for (operator, operand) in field.tests.iter() {
        if walk.unknown_key.is_none() && !FIELD_FILTER_OPERATORS.contains(&operator.as_str()) {
            walk.unknown_key = Some(UnknownKey {
                message: format!(
                    "Field \"{}\" is tested with \"{operator}\", which is no filter operator",
                    field.path
                ),
            });
        }
        tests += tests_of_operator(operator, operand);
        wanted |= checks_of(operator);
    }
    count_tests(walk, tests.max(1))?;
    for (at, check) in OPERAND_CHECKS.iter().enumerate() {
        if wanted & (1 << at) != 0 {
            check(field)?;
        }
    }
    Ok(())
}

fn owned_field_filters_of(fields: &Map, walk: &mut FilterWalk<'_>) -> Result<Map> {
    let mut owned = Map::with_capacity(fields.len());
    for (path, filter) in fields.iter() {
        let Some(declared) = walk.schema.field(path) else {
            return Err(undeclared_filter_field(path));
        };
        let Some(filter) = record_of(filter) else {
            return invalid_shape(format!(
                "The filter on field \"{path}\" must be an object of tests"
            ));
        };
        let mut tests = Map::with_capacity(filter.len());
        for (operator, operand) in filter.iter() {
            tests.insert(
                operator.clone(),
                owned_operand_of(operand, path, operator, 1)?,
            );
        }
        let field = FieldContext {
            path,
            field_type: &declared.field_type,
            declared: &declared.field_type.name,
            tests: &tests,
        };
        require_valid_field_tests(&field, walk)?;
        owned.insert(path.clone(), Value::Object(tests));
    }
    Ok(owned)
}

fn note_unknown_expression_key(expression: &Map, walk: &mut FilterWalk<'_>) {
    let Some(key) = expression
        .keys()
        .find(|key| !EXPRESSION_KEYS.contains(&key.as_str()))
    else {
        return;
    };
    walk.unknown_key = Some(UnknownKey {
        message: format!(
            "A filter expression takes \"fields\", \"and\", \"or\", and \"not\", and \"{key}\" is none of them. A per-field test such as {{ {key}: {{ eq: ... }} }} belongs under \"fields\""
        ),
    });
}

fn holds_nested_expressions(expression: &Map) -> bool {
    let listed =
        |key: &str| matches!(expression.get(key), Some(Value::Array(list)) if !list.is_empty());
    listed("and") || listed("or") || expression.contains_key("not")
}

fn owned_clause_of(
    clause: &str,
    list: &Value,
    walk: &mut FilterWalk<'_>,
    depth: usize,
) -> Result<Value> {
    let Value::Array(list) = list else {
        return invalid_shape(format!(
            "\"{clause}\" in a filter expression must be a list of filter expressions"
        ));
    };
    let mut owned = Vec::with_capacity(list.len());
    for nested in list {
        owned.push(Value::Object(owned_expression_of(nested, walk, depth + 1)?));
    }
    Ok(Value::Array(owned))
}

fn owned_expression_of(expression: &Value, walk: &mut FilterWalk<'_>, depth: usize) -> Result<Map> {
    if depth > MAX_FILTER_DEPTH {
        return invalid_shape(format!(
            "A filter expression nests at most {MAX_FILTER_DEPTH} levels deep"
        ));
    }
    let Some(expression) = record_of(expression) else {
        return invalid_shape("Each filter expression must be an object");
    };
    if walk.unknown_key.is_none() {
        note_unknown_expression_key(&expression, walk);
    }
    let fields = match expression.get("fields") {
        None => None,
        Some(fields) => match record_of(fields) {
            Some(fields) => Some(fields),
            None => {
                return invalid_shape(
                    "\"fields\" in a filter expression must be an object keyed by field path",
                );
            }
        },
    };
    let mut owned = Map::new();
    let field_count = fields.as_ref().map_or(0, |fields| fields.len());
    if field_count == 0 && !holds_nested_expressions(&expression) {
        count_tests(walk, 1)?;
    }
    if let Some(fields) = fields {
        owned.insert(
            "fields",
            Value::Object(owned_field_filters_of(&fields, walk)?),
        );
    }
    for clause in ["and", "or"] {
        if let Some(list) = expression.get(clause) {
            owned.insert(clause, owned_clause_of(clause, list, walk, depth)?);
        }
    }
    if let Some(not) = expression.get("not") {
        owned.insert(
            "not",
            Value::Object(owned_expression_of(not, walk, depth + 1)?),
        );
    }
    Ok(owned)
}

pub(crate) fn validated_filter_of(expression: &Value, schema: &CompiledSchema) -> Result<Map> {
    let mut walk = FilterWalk {
        schema,
        tests: 0,
        unknown_key: None,
    };
    let validated = owned_expression_of(expression, &mut walk, 0)?;
    if let Some(unknown) = walk.unknown_key {
        return invalid(unknown.message);
    }
    Ok(validated)
}
