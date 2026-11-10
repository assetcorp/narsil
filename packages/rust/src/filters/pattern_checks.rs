use super::checks::{FieldContext, invalid};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::pattern::constants::{MAX_PATTERN_POSITIONS, MAX_PATTERN_TEXT_CODE_POINTS};
use crate::pattern::expression::{ExpressionOperator, check_expression};
use crate::pattern::text::folded_code_point_count;
use crate::pattern::typo_text::{distinct_typo_run_count, fold_typo_text, typo_runs_needed};
use crate::value::{Value, number_to_text};

const PATTERN_TEST_OPERATORS: [&str; 7] = [
    "eq",
    "ne",
    "in",
    "nin",
    "startsWith",
    "endsWith",
    "contains",
];
const PATTERN_ELEMENT_OPERATORS: [&str; 2] = ["matchesAny", "containsAll"];
const EXPRESSION_OPERATORS: [(&str, ExpressionOperator); 2] = [
    ("wildcard", ExpressionOperator::Wildcard),
    ("regex", ExpressionOperator::Regex),
];

fn require_pattern_field(field: &FieldContext<'_>, operator: &str) -> Result<()> {
    if field.field_type.pattern {
        return Ok(());
    }
    invalid(format!(
        "\"{operator}\" applies only to a pattern field, because only a pattern field has a pattern index. A pattern field is a \"verbatim\" field, or a text field whose type includes \"pattern\". Field \"{}\" has type \"{}\"",
        field.path, field.declared
    ))
}

fn case_fold_of(field: &FieldContext<'_>) -> bool {
    matches!(field.get("caseFold"), Some(Value::Bool(true)))
}

fn require_text_length(path: &str, operator: &str, text: &str) -> Result<()> {
    if text.chars().nth(MAX_PATTERN_TEXT_CODE_POINTS).is_none() {
        return Ok(());
    }
    invalid(format!(
        "The text of \"{operator}\" on pattern field \"{path}\" holds more than {MAX_PATTERN_TEXT_CODE_POINTS} code points"
    ))
}

fn require_pattern_text(path: &str, operator: &str, text: &str, case_fold: bool) -> Result<()> {
    require_text_length(path, operator, text)?;
    if case_fold && folded_code_point_count(text) > MAX_PATTERN_POSITIONS as usize {
        return invalid(format!(
            "The text of \"{operator}\" on pattern field \"{path}\" has a case fold of more than {MAX_PATTERN_POSITIONS} code points, while a pattern holds at most {MAX_PATTERN_POSITIONS} positions"
        ));
    }
    Ok(())
}

fn is_pattern_tolerance(value: &Value) -> bool {
    match value {
        Value::String(text) => text == "auto",
        Value::Number(number) => number.fract() == 0.0 && (0.0..=2.0).contains(number),
        _ => false,
    }
}

fn require_tolerance(field: &FieldContext<'_>) -> Result<()> {
    let path = field.path;
    let Some(tolerance) = field.get("tolerance") else {
        return Ok(());
    };
    if !is_pattern_tolerance(tolerance) {
        return invalid(format!(
            "\"tolerance\" on field \"{path}\" must be 0, 1, 2, or \"auto\""
        ));
    }
    let Some(Value::String(eq)) = field.get("eq") else {
        return invalid(format!(
            "\"tolerance\" applies only to an \"eq\" test, while the filter on field \"{path}\" sets no \"eq\" with text"
        ));
    };
    let Value::Number(count) = tolerance else {
        return Ok(());
    };
    if *count == 0.0 {
        return Ok(());
    }
    let text = fold_typo_text(eq);
    let required = typo_runs_needed(*count as u32, text.longest_fold);
    let distinct = distinct_typo_run_count(&text, required);
    if distinct >= required {
        return Ok(());
    }
    Err(NarsilError::new(
        ErrorCode::SEARCH_INVALID_FILTER,
        format!(
            "A tolerance of {} on \"eq\" of pattern field \"{path}\" needs {required} distinct runs of three code points in the case fold of the text, while the text holds {distinct}. Lengthen the text, lower the tolerance, or set it to \"auto\"",
            number_to_text(*count)
        ),
    ))
}

fn check_pattern_operands(field: &FieldContext<'_>) -> Result<()> {
    let path = field.path;
    let case_fold = case_fold_of(field);
    for (name, operator) in EXPRESSION_OPERATORS {
        let Some(Value::String(pattern)) = field.get(name) else {
            continue;
        };
        require_text_length(path, name, pattern)?;
        check_expression(operator, pattern, case_fold, path)?;
    }
    for operator in PATTERN_TEST_OPERATORS {
        match field.get(operator) {
            Some(Value::String(text)) => require_pattern_text(path, operator, text, case_fold)?,
            Some(Value::Array(texts)) => {
                for text in texts {
                    if let Value::String(text) = text {
                        require_pattern_text(path, operator, text, case_fold)?;
                    }
                }
            }
            _ => {}
        }
    }
    for operator in PATTERN_ELEMENT_OPERATORS {
        let Some(Value::Array(texts)) = field.get(operator) else {
            continue;
        };
        for text in texts {
            if let Value::String(text) = text {
                require_pattern_text(path, operator, text, false)?;
            }
        }
    }
    require_tolerance(field)
}

pub(crate) fn require_pattern_operands(field: &FieldContext<'_>) -> Result<()> {
    let path = field.path;
    if let Some(contains) = field.get("contains") {
        if !matches!(contains, Value::String(_)) {
            return invalid(format!("\"contains\" on field \"{path}\" must be a string"));
        }
        require_pattern_field(field, "contains")?;
    }
    if let Some(case_fold) = field.get("caseFold") {
        if !matches!(case_fold, Value::Bool(_)) {
            return invalid(format!(
                "\"caseFold\" on field \"{path}\" must be true or false"
            ));
        }
        require_pattern_field(field, "caseFold")?;
    }
    for (name, _) in EXPRESSION_OPERATORS {
        let Some(pattern) = field.get(name) else {
            continue;
        };
        if !matches!(pattern, Value::String(_)) {
            return invalid(format!("\"{name}\" on field \"{path}\" must be a string"));
        }
        require_pattern_field(field, name)?;
    }
    if field.has("tolerance") {
        require_pattern_field(field, "tolerance")?;
    }
    if !field.field_type.pattern {
        return Ok(());
    }
    check_pattern_operands(field)
}
