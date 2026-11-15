use super::checks::{
    FieldContext, OperandKind, base_name, finite_number, invalid_operand, kind_of_value,
    require_list_length,
};
use crate::error::Result;
use crate::schema::BaseType;
use crate::value::Value;

const WHOLE_VALUE_OPERATORS: [&str; 8] = [
    "eq",
    "ne",
    "in",
    "nin",
    "startsWith",
    "endsWith",
    "matchesAny",
    "containsAll",
];
const ELEMENT_OPERATORS: [&str; 2] = ["matchesAny", "containsAll"];
pub(crate) const PRESENCE_OPERATORS: [&str; 4] = ["exists", "notExists", "isEmpty", "isNotEmpty"];
const SIZE_OPERATORS: [&str; 7] = ["eq", "ne", "gt", "gte", "lt", "lte", "between"];

pub(crate) fn require_whole_value_index(field: &FieldContext<'_>) -> Result<()> {
    let field_type = field.field_type;
    let analysed = matches!(field_type.base, BaseType::String | BaseType::StringList);
    if field_type.pattern || !analysed {
        return Ok(());
    }
    let base = base_name(field_type.base);
    for operator in WHOLE_VALUE_OPERATORS {
        if !field.has(operator) {
            continue;
        }
        return invalid_operand(
            format!(
                "\"{operator}\" compares whole values of field \"{}\", which the engine finds only through a pattern index. A \"{base}\" field keeps a pattern index where its type includes \"pattern\", so declare the field as \"{base}:pattern\" in a new index to filter it this way",
                field.path
            ),
            field.path,
            operator,
        );
    }
    Ok(())
}

pub(crate) fn require_presence_operands(field: &FieldContext<'_>) -> Result<()> {
    for operator in PRESENCE_OPERATORS {
        match field.get(operator) {
            None | Some(Value::Bool(_)) => {}
            Some(_) => {
                return invalid_operand(
                    format!(
                        "\"{operator}\" on field \"{}\" must be true or false",
                        field.path
                    ),
                    field.path,
                    operator,
                );
            }
        }
    }
    Ok(())
}

fn list_element_kind(field: &FieldContext<'_>, operator: &str) -> Result<OperandKind> {
    match field.field_type.base {
        BaseType::NumberList => Ok(OperandKind::Number),
        BaseType::BooleanList => Ok(OperandKind::Boolean),
        BaseType::EnumList | BaseType::StringList | BaseType::VerbatimList => Ok(OperandKind::Text),
        _ => invalid_operand(
            format!(
                "\"{operator}\" tests the elements of a list field, while the schema declares field \"{}\" as \"{}\"",
                field.path, field.declared
            ),
            field.path,
            operator,
        ),
    }
}

fn element_noun(kind: OperandKind) -> &'static str {
    match kind {
        OperandKind::Text => "string",
        OperandKind::Number => "finite number",
        _ => "boolean",
    }
}

pub(crate) fn require_element_operands(field: &FieldContext<'_>) -> Result<()> {
    let path = field.path;
    for operator in ELEMENT_OPERATORS {
        let Some(operand) = field.get(operator) else {
            continue;
        };
        let Value::Array(values) = operand else {
            return invalid_operand(
                format!("\"{operator}\" on field \"{path}\" must be a list"),
                path,
                operator,
            );
        };
        require_list_length(path, operator, values.len())?;
        let kind = list_element_kind(field, operator)?;
        if values
            .iter()
            .any(|value| kind_of_value(Some(value)) != Some(kind))
        {
            return invalid_operand(
                format!(
                    "Every value of \"{operator}\" on field \"{path}\" must be a {}, because the field holds a list of them",
                    element_noun(kind)
                ),
                path,
                operator,
            );
        }
    }
    Ok(())
}

pub(crate) fn require_size_operands(field: &FieldContext<'_>) -> Result<()> {
    let path = field.path;
    let Some(size) = field.get("size") else {
        return Ok(());
    };
    let Value::Object(comparison) = size else {
        return invalid_operand(
            format!("\"size\" on field \"{path}\" must be a comparison object"),
            path,
            "size",
        );
    };
    list_element_kind(field, "size")?;
    for (operator, operand) in comparison.iter() {
        if !SIZE_OPERATORS.contains(&operator.as_str()) {
            return invalid_operand(
                format!(
                    "\"size\" on field \"{path}\" takes {}, while \"{operator}\" is none of them",
                    SIZE_OPERATORS.join(", ")
                ),
                path,
                "size",
            );
        }
        let between = operator == "between";
        let valid = if between {
            match operand {
                Value::Array(bounds) => {
                    bounds.len() == 2
                        && bounds
                            .iter()
                            .all(|bound| finite_number(Some(bound)).is_some())
                }
                _ => false,
            }
        } else {
            finite_number(Some(operand)).is_some()
        };
        if !valid {
            let wanted = if between {
                "two finite numbers, the lower bound first"
            } else {
                "a finite number"
            };
            return invalid_operand(
                format!("\"size.{operator}\" on field \"{path}\" must be {wanted}"),
                path,
                "size",
            );
        }
    }
    Ok(())
}
