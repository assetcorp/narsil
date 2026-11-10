use std::collections::HashSet;

use super::compile::{
    COMPARISON_OPERATORS, ElementTest, EnumMatch, FieldTest, NumberTest, flag, prepared_all, text,
};
use super::source::Comparison;
use crate::error::Result;
use crate::pattern::{PatternOperator, PatternTolerance, prepare_pattern};
use crate::schema::BaseType;
use crate::value::{Map, Value};

fn comparison_of(operator: &str, operand: &Value) -> Option<NumberTest> {
    if operator == "between" {
        let Value::Array(bounds) = operand else {
            return None;
        };
        let [Value::Number(low), Value::Number(high)] = bounds.as_slice() else {
            return None;
        };
        return Some(NumberTest::Is(Comparison::Between(*low, *high)));
    }
    let Value::Number(bound) = operand else {
        return None;
    };
    let bound = *bound;
    Some(match operator {
        "eq" => NumberTest::Is(Comparison::Eq(bound)),
        "ne" => NumberTest::IsNot(bound),
        "gt" => NumberTest::Is(Comparison::Gt(bound)),
        "gte" => NumberTest::Is(Comparison::Gte(bound)),
        "lt" => NumberTest::Is(Comparison::Lt(bound)),
        _ => NumberTest::Is(Comparison::Lte(bound)),
    })
}

fn comparisons(tests: &Map) -> impl Iterator<Item = NumberTest> + '_ {
    COMPARISON_OPERATORS.into_iter().filter_map(|operator| {
        tests
            .get(operator)
            .and_then(|operand| comparison_of(operator, operand))
    })
}

fn owned_texts(operand: &Value) -> HashSet<String> {
    match operand {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => HashSet::new(),
    }
}

fn enum_tests(tests: &Map, compiled: &mut Vec<FieldTest>) {
    for (operator, exclude) in [("eq", false), ("ne", true)] {
        if let Some(value) = text(tests, operator) {
            let values = EnumMatch::Values(HashSet::from([value.to_string()]));
            compiled.push(FieldTest::Enum { values, exclude });
        }
    }
    for (operator, exclude) in [("in", false), ("nin", true)] {
        if let Some(operand @ Value::Array(_)) = tests.get(operator) {
            let values = EnumMatch::Values(owned_texts(operand));
            compiled.push(FieldTest::Enum { values, exclude });
        }
    }
    if let Some(prefix) = text(tests, "startsWith") {
        let values = EnumMatch::Prefix(prefix.to_string());
        compiled.push(FieldTest::Enum {
            values,
            exclude: false,
        });
    }
    if let Some(suffix) = text(tests, "endsWith") {
        let values = EnumMatch::Suffix(suffix.to_string());
        compiled.push(FieldTest::Enum {
            values,
            exclude: false,
        });
    }
}

pub(super) fn value_tests(tests: &Map, base: BaseType, compiled: &mut Vec<FieldTest>) {
    match base {
        BaseType::Number | BaseType::NumberList => {
            compiled.extend(comparisons(tests).map(FieldTest::Number));
        }
        BaseType::Boolean | BaseType::BooleanList => {
            for (operator, exclude) in [("eq", false), ("ne", true)] {
                if let Some(value) = flag(tests, operator) {
                    compiled.push(FieldTest::Boolean { value, exclude });
                }
            }
        }
        BaseType::Enum | BaseType::EnumList => enum_tests(tests, compiled),
        _ => {}
    }
}

#[derive(PartialEq, Eq, Hash)]
enum ScalarKey<'a> {
    Text(&'a str),
    Number(u64),
    Boolean(bool),
}

fn scalar_key(value: &Value) -> Option<ScalarKey<'_>> {
    match value {
        Value::String(text) => Some(ScalarKey::Text(text)),
        Value::Number(number) if *number == 0.0 => Some(ScalarKey::Number(0)),
        Value::Number(number) => Some(ScalarKey::Number(number.to_bits())),
        Value::Bool(flag) => Some(ScalarKey::Boolean(*flag)),
        _ => None,
    }
}

fn distinct_scalars(operand: &Value) -> Vec<&Value> {
    let mut seen = HashSet::new();
    let mut distinct = Vec::new();
    if let Value::Array(items) = operand {
        for item in items {
            if scalar_key(item).is_some_and(|key| seen.insert(key)) {
                distinct.push(item);
            }
        }
    }
    distinct
}

fn element_test(value: &Value, pattern: bool) -> Result<Option<ElementTest>> {
    Ok(match value {
        Value::String(text) if pattern => {
            let exact = PatternTolerance::Fixed(0);
            let prepared = prepare_pattern(PatternOperator::Eq, text, false, exact)?;
            Some(ElementTest::Pattern(Box::new(prepared)))
        }
        Value::String(text) => Some(ElementTest::Enum(text.clone())),
        Value::Number(number) => Some(ElementTest::Number(*number)),
        Value::Bool(flag) => Some(ElementTest::Boolean(*flag)),
        _ => None,
    })
}

fn any_element_test(values: &[&Value], base: BaseType, pattern: bool) -> Result<FieldTest> {
    if pattern {
        let texts: Vec<&str> = values.iter().filter_map(|value| value.as_str()).collect();
        let exact = PatternTolerance::Fixed(0);
        let patterns = prepared_all(PatternOperator::Eq, &texts, false, exact)?;
        return Ok(FieldTest::AnyPattern(patterns));
    }
    if base == BaseType::EnumList {
        let texts = values
            .iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect();
        return Ok(FieldTest::AnyEnum(texts));
    }
    Ok(FieldTest::AnyScalar {
        numbers: values.iter().filter_map(|value| value.as_f64()).collect(),
        booleans: values.iter().filter_map(|value| value.as_bool()).collect(),
    })
}

pub(super) fn element_tests(
    tests: &Map,
    base: BaseType,
    pattern: bool,
    compiled: &mut Vec<FieldTest>,
) -> Result<()> {
    if let Some(operand) = tests.get("matchesAny") {
        let values = distinct_scalars(operand);
        compiled.push(any_element_test(&values, base, pattern)?);
    }
    if let Some(operand) = tests.get("containsAll") {
        let mut elements = Vec::new();
        for value in distinct_scalars(operand) {
            if let Some(element) = element_test(value, pattern)? {
                elements.push(element);
            }
        }
        compiled.push(FieldTest::AllElements(elements));
    }
    if let Some(Value::Object(comparison)) = tests.get("size") {
        compiled.extend(comparisons(comparison).map(FieldTest::Size));
    }
    Ok(())
}
