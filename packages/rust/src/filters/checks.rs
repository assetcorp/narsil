use super::constants::MAX_FILTER_ARRAY_SIZE;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::schema::{BaseType, FieldType};
use crate::value::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OperandKind {
    Number,
    Boolean,
    Text,
    Geopoint,
    Vector,
}

impl OperandKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            OperandKind::Number => "number",
            OperandKind::Boolean => "boolean",
            OperandKind::Text => "text",
            OperandKind::Geopoint => "geopoint",
            OperandKind::Vector => "vector",
        }
    }
}

pub(crate) struct FieldContext<'a> {
    pub(crate) path: &'a str,
    pub(crate) field_type: &'a FieldType,
    pub(crate) declared: &'a str,
    pub(crate) tests: &'a Map,
}

impl FieldContext<'_> {
    pub(crate) fn get(&self, operator: &str) -> Option<&Value> {
        self.tests.get(operator)
    }

    pub(crate) fn has(&self, operator: &str) -> bool {
        self.tests.contains_key(operator)
    }
}

pub(crate) fn invalid<T>(message: impl Into<String>) -> Result<T> {
    Err(NarsilError::new(ErrorCode::SEARCH_INVALID_FILTER, message))
}

fn operand_kind_of(field_type: &FieldType) -> OperandKind {
    match field_type.base {
        BaseType::Number | BaseType::NumberList => OperandKind::Number,
        BaseType::Boolean | BaseType::BooleanList => OperandKind::Boolean,
        BaseType::Geopoint => OperandKind::Geopoint,
        BaseType::Vector => OperandKind::Vector,
        _ => OperandKind::Text,
    }
}

pub(crate) fn finite_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) if number.is_finite() => Some(*number),
        _ => None,
    }
}

pub(crate) fn kind_of_value(value: Option<&Value>) -> Option<OperandKind> {
    match value {
        Some(Value::Number(number)) if number.is_finite() => Some(OperandKind::Number),
        Some(Value::Bool(_)) => Some(OperandKind::Boolean),
        Some(Value::String(_)) => Some(OperandKind::Text),
        _ => None,
    }
}

pub(crate) fn base_name(base: BaseType) -> &'static str {
    match base {
        BaseType::String => "string",
        BaseType::StringList => "string[]",
        BaseType::Verbatim => "verbatim",
        BaseType::VerbatimList => "verbatim[]",
        BaseType::Number => "number",
        BaseType::NumberList => "number[]",
        BaseType::Boolean => "boolean",
        BaseType::BooleanList => "boolean[]",
        BaseType::Enum => "enum",
        BaseType::EnumList => "enum[]",
        BaseType::Geopoint => "geopoint",
        BaseType::Vector => "vector",
    }
}

fn require_field_kind(
    field: &FieldContext<'_>,
    operator: &str,
    accepted: OperandKind,
) -> Result<()> {
    if operand_kind_of(field.field_type) == accepted {
        return Ok(());
    }
    invalid(format!(
        "The engine applies \"{operator}\" to {} fields alone, and the schema declares field \"{}\" as \"{}\"",
        accepted.as_str(),
        field.path,
        field.declared
    ))
}

fn require_text_range_field(field: &FieldContext<'_>, operator: &str) -> Result<()> {
    let field_type = field.field_type;
    let text_base = matches!(field_type.base, BaseType::String | BaseType::Verbatim);
    if field_type.sortable && text_base {
        return Ok(());
    }
    invalid(format!(
        "The engine applies \"{operator}\" with a text bound to a \"string\" or \"verbatim\" field whose type includes \"sortable\", but field \"{}\" has type \"{}\"",
        field.path, field.declared
    ))
}

pub(crate) fn require_list_length(path: &str, operator: &str, length: usize) -> Result<()> {
    if length <= MAX_FILTER_ARRAY_SIZE {
        return Ok(());
    }
    invalid(format!(
        "\"{operator}\" on field \"{path}\" holds {length} values, while a filter list holds at most {MAX_FILTER_ARRAY_SIZE}"
    ))
}

const RANGE_OPERATORS: [&str; 4] = ["gt", "lt", "gte", "lte"];

pub(crate) fn require_range_operands(field: &FieldContext<'_>) -> Result<()> {
    let path = field.path;
    for operator in RANGE_OPERATORS {
        let Some(bound) = field.get(operator) else {
            continue;
        };
        if let Value::String(_) = bound {
            require_text_range_field(field, operator)?;
            continue;
        }
        if finite_number(Some(bound)).is_none() {
            return invalid(format!(
                "\"{operator}\" on field \"{path}\" must be a finite number or a string"
            ));
        }
        require_field_kind(field, operator, OperandKind::Number)?;
    }
    let Some(bounds) = field.get("between") else {
        return Ok(());
    };
    let pair = match bounds {
        Value::Array(items) if items.len() == 2 => Some((&items[0], &items[1])),
        _ => None,
    };
    if let Some((Value::String(_), Value::String(_))) = pair {
        return require_text_range_field(field, "between");
    }
    let numbers = pair.is_some_and(|(low, high)| {
        finite_number(Some(low)).is_some() && finite_number(Some(high)).is_some()
    });
    if !numbers {
        return invalid(format!(
            "\"between\" on field \"{path}\" must be two finite numbers or two strings, the lower bound first"
        ));
    }
    require_field_kind(field, "between", OperandKind::Number)
}

pub(crate) fn require_value_operands(field: &FieldContext<'_>) -> Result<()> {
    let path = field.path;
    for operator in ["startsWith", "endsWith"] {
        let Some(operand) = field.get(operator) else {
            continue;
        };
        if !matches!(operand, Value::String(_)) {
            return invalid(format!(
                "\"{operator}\" on field \"{path}\" must be a string"
            ));
        }
        require_field_kind(field, operator, OperandKind::Text)?;
    }
    for operator in ["eq", "ne"] {
        if !field.has(operator) {
            continue;
        }
        let Some(kind) = kind_of_value(field.get(operator)) else {
            return invalid(format!(
                "\"{operator}\" on field \"{path}\" must be a string, a finite number, or a boolean"
            ));
        };
        require_field_kind(field, operator, kind)?;
    }
    for operator in ["in", "nin"] {
        let Some(operand) = field.get(operator) else {
            continue;
        };
        let texts = match operand {
            Value::Array(items) if items.iter().all(|item| matches!(item, Value::String(_))) => {
                items
            }
            _ => {
                return invalid(format!(
                    "\"{operator}\" on field \"{path}\" must be a list of strings"
                ));
            }
        };
        require_list_length(path, operator, texts.len())?;
        require_field_kind(field, operator, OperandKind::Text)?;
    }
    for operator in ["radius", "polygon"] {
        if field.has(operator) {
            require_field_kind(field, operator, OperandKind::Geopoint)?;
        }
    }
    Ok(())
}
