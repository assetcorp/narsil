use std::collections::HashSet;

use super::compile_values::{element_tests, value_tests};
use super::geo_checks::metres_per_unit;
use super::source::{Comparison, truncated_sort_text};
use super::walk::validated_filter_of;
use crate::error::Result;
use crate::geo::{GeoPoint, GeoQuery};
use crate::pattern::{PatternOperator, PatternTolerance, PreparedPattern, prepare_pattern};
use crate::schema::{BaseType, CompiledSchema};
use crate::value::{Map, Value};

pub(super) const COMPARISON_OPERATORS: [&str; 7] =
    ["eq", "ne", "gt", "gte", "lt", "lte", "between"];
const TEXT_RANGE_OPERATORS: [&str; 4] = ["gt", "gte", "lt", "lte"];

pub(crate) enum NumberTest {
    Is(Comparison),
    IsNot(f64),
}

pub(crate) struct TextBound {
    pub(crate) text: String,
    pub(crate) inclusive: bool,
}

pub(crate) enum EnumMatch {
    Values(HashSet<String>),
    Prefix(String),
    Suffix(String),
}

pub(crate) enum ElementTest {
    Pattern(Box<PreparedPattern>),
    Number(f64),
    Boolean(bool),
    Enum(String),
}

pub(crate) enum FieldTest {
    Presence {
        keep_present: bool,
    },
    Holding {
        keep_holding: bool,
    },
    Location(Box<GeoQuery>),
    TextRange {
        lower: Option<TextBound>,
        upper: Option<TextBound>,
    },
    Pattern {
        patterns: Vec<PreparedPattern>,
        exclude: bool,
    },
    Number(NumberTest),
    Size(NumberTest),
    Boolean {
        value: bool,
        exclude: bool,
    },
    Enum {
        values: EnumMatch,
        exclude: bool,
    },
    AnyPattern(Vec<PreparedPattern>),
    AnyEnum(HashSet<String>),
    AnyScalar {
        numbers: Vec<f64>,
        booleans: Vec<bool>,
    },
    AllElements(Vec<ElementTest>),
}

pub(crate) struct FieldFilter {
    pub(crate) path: String,
    pub(crate) base: BaseType,
    pub(crate) tests: Vec<FieldTest>,
}

#[derive(Default)]
pub(crate) struct CompiledExpression {
    pub(crate) fields: Vec<FieldFilter>,
    pub(crate) and: Vec<CompiledExpression>,
    pub(crate) or: Vec<CompiledExpression>,
    pub(crate) not: Option<Box<CompiledExpression>>,
}

pub(crate) fn compile_filter(
    expression: &Value,
    schema: &CompiledSchema,
) -> Result<CompiledExpression> {
    let validated = validated_filter_of(expression, schema)?;
    compile_expression(&validated, schema)
}

fn compile_expression(expression: &Map, schema: &CompiledSchema) -> Result<CompiledExpression> {
    let mut compiled = CompiledExpression::default();
    if let Some(Value::Object(fields)) = expression.get("fields") {
        for (path, tests) in fields.iter() {
            let (Some(field), Value::Object(tests)) = (schema.field(path), tests) else {
                continue;
            };
            let field_type = &field.field_type;
            compiled.fields.push(FieldFilter {
                path: path.clone(),
                base: field_type.base,
                tests: compile_field(tests, field_type.base, field_type.pattern)?,
            });
        }
    }
    for (clause, target) in [("and", &mut compiled.and), ("or", &mut compiled.or)] {
        if let Some(Value::Array(list)) = expression.get(clause) {
            for nested in list {
                if let Value::Object(nested) = nested {
                    target.push(compile_expression(nested, schema)?);
                }
            }
        }
    }
    if let Some(Value::Object(not)) = expression.get("not") {
        compiled.not = Some(Box::new(compile_expression(not, schema)?));
    }
    Ok(compiled)
}

pub(super) fn flag(tests: &Map, operator: &str) -> Option<bool> {
    tests.get(operator).and_then(Value::as_bool)
}

pub(super) fn text<'a>(tests: &'a Map, operator: &str) -> Option<&'a str> {
    tests.get(operator).and_then(Value::as_str)
}

fn distinct_texts(operand: &Value) -> Vec<&str> {
    let mut seen = HashSet::new();
    let mut texts = Vec::new();
    if let Value::Array(items) = operand {
        for item in items {
            if let Value::String(text) = item {
                if seen.insert(text.as_str()) {
                    texts.push(text.as_str());
                }
            }
        }
    }
    texts
}

fn compile_field(tests: &Map, base: BaseType, pattern: bool) -> Result<Vec<FieldTest>> {
    let mut compiled = Vec::new();
    presence_tests(tests, &mut compiled);
    location_tests(tests, &mut compiled);
    text_range_tests(tests, &mut compiled);
    if pattern {
        pattern_tests(tests, &mut compiled)?;
    } else {
        value_tests(tests, base, &mut compiled);
    }
    element_tests(tests, base, pattern, &mut compiled)?;
    Ok(compiled)
}

fn presence_tests(tests: &Map, compiled: &mut Vec<FieldTest>) {
    if let Some(exists) = flag(tests, "exists") {
        compiled.push(FieldTest::Presence {
            keep_present: exists,
        });
    }
    if let Some(missing) = flag(tests, "notExists") {
        compiled.push(FieldTest::Presence {
            keep_present: !missing,
        });
    }
    if let Some(holding) = flag(tests, "isNotEmpty") {
        compiled.push(FieldTest::Holding {
            keep_holding: holding,
        });
    }
    if let Some(empty) = flag(tests, "isEmpty") {
        compiled.push(FieldTest::Holding {
            keep_holding: !empty,
        });
    }
}

fn number_of(map: &Map, key: &str) -> f64 {
    map.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

fn radius_query(circle: &Map) -> GeoQuery {
    let metres = circle
        .get("unit")
        .and_then(Value::as_str)
        .and_then(metres_per_unit)
        .unwrap_or(f64::NAN);
    GeoQuery::radius(
        number_of(circle, "lat"),
        number_of(circle, "lon"),
        number_of(circle, "distance") * metres,
        flag(circle, "inside").unwrap_or(true),
        flag(circle, "highPrecision").unwrap_or(false),
    )
}

fn polygon_query(polygon: &Map) -> GeoQuery {
    let points: Vec<GeoPoint> = match polygon.get("points") {
        Some(Value::Array(points)) => points
            .iter()
            .filter_map(|point| match point {
                Value::Object(point) => Some(GeoPoint {
                    lat: number_of(point, "lat"),
                    lon: number_of(point, "lon"),
                }),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    GeoQuery::polygon(&points, flag(polygon, "inside").unwrap_or(true))
}

fn location_tests(tests: &Map, compiled: &mut Vec<FieldTest>) {
    if let Some(Value::Object(circle)) = tests.get("radius") {
        compiled.push(FieldTest::Location(Box::new(radius_query(circle))));
    }
    if let Some(Value::Object(polygon)) = tests.get("polygon") {
        compiled.push(FieldTest::Location(Box::new(polygon_query(polygon))));
    }
}

fn text_bound(text: &str, inclusive: bool) -> TextBound {
    TextBound {
        text: truncated_sort_text(text).to_string(),
        inclusive,
    }
}

fn text_range_tests(tests: &Map, compiled: &mut Vec<FieldTest>) {
    for operator in TEXT_RANGE_OPERATORS {
        let Some(bound) = text(tests, operator) else {
            continue;
        };
        let inclusive = matches!(operator, "gte" | "lte");
        let bound = Some(text_bound(bound, inclusive));
        let (lower, upper) = if matches!(operator, "gt" | "gte") {
            (bound, None)
        } else {
            (None, bound)
        };
        compiled.push(FieldTest::TextRange { lower, upper });
    }
    if let Some(Value::Array(bounds)) = tests.get("between") {
        if let [Value::String(low), Value::String(high)] = bounds.as_slice() {
            compiled.push(FieldTest::TextRange {
                lower: Some(text_bound(low, true)),
                upper: Some(text_bound(high, true)),
            });
        }
    }
}

fn tolerance_of(tests: &Map) -> PatternTolerance {
    match tests.get("tolerance") {
        Some(Value::String(text)) if text == "auto" => PatternTolerance::Auto,
        Some(Value::Number(count)) if (0.0..=2.0).contains(count) && count.fract() == 0.0 => {
            PatternTolerance::Fixed(*count as u32)
        }
        _ => PatternTolerance::Fixed(0),
    }
}

pub(super) fn prepared_all(
    operator: PatternOperator,
    texts: &[&str],
    case_fold: bool,
    tolerance: PatternTolerance,
) -> Result<Vec<PreparedPattern>> {
    texts
        .iter()
        .map(|text| prepare_pattern(operator, text, case_fold, tolerance))
        .collect()
}

const SINGLE_TEXT_PATTERN_OPERATORS: [(&str, PatternOperator); 5] = [
    ("startsWith", PatternOperator::StartsWith),
    ("endsWith", PatternOperator::EndsWith),
    ("contains", PatternOperator::Contains),
    ("wildcard", PatternOperator::Wildcard),
    ("regex", PatternOperator::Regex),
];

fn pattern_tests(tests: &Map, compiled: &mut Vec<FieldTest>) -> Result<()> {
    let case_fold = flag(tests, "caseFold") == Some(true);
    let exact = PatternTolerance::Fixed(0);
    let mut push = |operator, texts: &[&str], tolerance, exclude| -> Result<()> {
        let patterns = prepared_all(operator, texts, case_fold, tolerance)?;
        compiled.push(FieldTest::Pattern { patterns, exclude });
        Ok(())
    };
    if let Some(eq) = text(tests, "eq") {
        push(PatternOperator::Eq, &[eq], tolerance_of(tests), false)?;
    }
    if let Some(ne) = text(tests, "ne") {
        push(PatternOperator::Eq, &[ne], exact, true)?;
    }
    if let Some(operand) = tests.get("in") {
        push(PatternOperator::Eq, &distinct_texts(operand), exact, false)?;
    }
    if let Some(operand) = tests.get("nin") {
        push(PatternOperator::Eq, &distinct_texts(operand), exact, true)?;
    }
    for (name, operator) in SINGLE_TEXT_PATTERN_OPERATORS {
        if let Some(operand) = text(tests, name) {
            push(operator, &[operand], exact, false)?;
        }
    }
    Ok(())
}
