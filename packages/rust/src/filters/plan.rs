use super::geo_checks::metres_per_unit;
use super::plan_values::{element_plan, pattern_plan, size_plan, value_plan};
use super::program::FilterProgram;
use super::text_range::{TextBound, text_range_bits};
use super::tree::{FieldNode, FilterNode};
use crate::error::Result;
use crate::ffi;
use crate::schema::BaseType;
use crate::value::{Map, Value};

const PRESENCE_OPERATORS: [(&str, bool); 4] = [
    ("exists", false),
    ("notExists", true),
    ("isNotEmpty", false),
    ("isEmpty", true),
];
const TEXT_RANGE_OPERATORS: [&str; 4] = ["gt", "gte", "lt", "lte"];

#[derive(Default)]
pub(super) struct Conjunction {
    count: u32,
}

impl Conjunction {
    pub(super) fn append(&mut self, program: &mut FilterProgram<'_>) {
        if self.count != 0 {
            program.emit(ffi::NARSIL_FILTER_AND, 0, 0, 2);
        }
        self.count += 1;
    }

    fn finish(&self, program: &mut FilterProgram<'_>) {
        if self.count == 0 {
            program.live_bitset();
        }
    }
}

pub(super) fn flag(tests: &Map, operator: &str) -> Option<bool> {
    tests.get(operator).and_then(Value::as_bool)
}

pub(super) fn text<'a>(tests: &'a Map, operator: &str) -> Option<&'a str> {
    tests.get(operator).and_then(Value::as_str)
}

fn number_of(map: &Map, key: &str) -> f64 {
    map.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

pub(super) fn expression_plan(node: &FilterNode, program: &mut FilterProgram<'_>) -> Result<()> {
    let mut joined = Conjunction::default();
    for field in &node.fields {
        field_plan(field, program)?;
        joined.append(program);
    }
    for nested in &node.and {
        expression_plan(nested, program)?;
        joined.append(program);
    }
    for (at, nested) in node.or.iter().enumerate() {
        expression_plan(nested, program)?;
        if at != 0 {
            program.emit(ffi::NARSIL_FILTER_OR, 0, 0, 2);
        }
    }
    if !node.or.is_empty() {
        joined.append(program);
    }
    if let Some(not) = &node.not {
        expression_plan(not, program)?;
        program.emit(ffi::NARSIL_FILTER_NOT, 0, 0, 0);
        joined.append(program);
    }
    joined.finish(program);
    Ok(())
}

pub(super) fn and_not(program: &mut FilterProgram<'_>) {
    program.emit(ffi::NARSIL_FILTER_ANDNOT, 0, 0, 0);
}

fn holding(program: &mut FilterProgram<'_>, node: &FieldNode, field: u32) -> Result<()> {
    program.emit(ffi::NARSIL_FILTER_PRESENT, field, 0, 0);
    if program.holds_sizes(&node.path) {
        let sizes = program.field(&node.path, node.base, true)?;
        program.test_numbers(sizes, ffi::NARSIL_FILTER_EQ, &[0.0]);
        and_not(program);
    }
    Ok(())
}

fn presence_plan(
    node: &FieldNode,
    field: u32,
    program: &mut FilterProgram<'_>,
    joined: &mut Conjunction,
) -> Result<()> {
    for (operator, negated_by) in PRESENCE_OPERATORS {
        let Some(value) = flag(&node.tests, operator) else {
            continue;
        };
        if matches!(operator, "exists" | "notExists") {
            program.emit(ffi::NARSIL_FILTER_PRESENT, field, 0, 0);
        } else {
            holding(program, node, field)?;
        }
        if value == negated_by {
            program.emit(ffi::NARSIL_FILTER_NOT, 0, 0, 0);
        }
        joined.append(program);
    }
    Ok(())
}

fn location(
    program: &mut FilterProgram<'_>,
    field: u32,
    operator: u32,
    numbers: &[f64],
    inside: bool,
    joined: &mut Conjunction,
) {
    if !inside {
        program.emit(ffi::NARSIL_FILTER_PRESENT, field, 0, 0);
    }
    program.test_numbers(field, operator, numbers);
    if !inside {
        and_not(program);
    }
    joined.append(program);
}

fn location_plan(
    node: &FieldNode,
    field: u32,
    program: &mut FilterProgram<'_>,
    joined: &mut Conjunction,
) {
    if let Some(Value::Object(circle)) = node.tests.get("radius") {
        let metres = circle
            .get("unit")
            .and_then(Value::as_str)
            .and_then(metres_per_unit)
            .unwrap_or(f64::NAN);
        let numbers = [
            number_of(circle, "lat"),
            number_of(circle, "lon"),
            number_of(circle, "distance") * metres,
            f64::from(u8::from(flag(circle, "highPrecision").unwrap_or(false))),
        ];
        let inside = flag(circle, "inside").unwrap_or(true);
        location(
            program,
            field,
            ffi::NARSIL_FILTER_RADIUS,
            &numbers,
            inside,
            joined,
        );
    }
    if let Some(Value::Object(polygon)) = node.tests.get("polygon") {
        let mut numbers = vec![0.0];
        if let Some(Value::Array(points)) = polygon.get("points") {
            for point in points {
                if let Value::Object(point) = point {
                    numbers.push(number_of(point, "lat"));
                    numbers.push(number_of(point, "lon"));
                }
            }
        }
        numbers[0] = ((numbers.len() - 1) / 2) as f64;
        let inside = flag(polygon, "inside").unwrap_or(true);
        location(
            program,
            field,
            ffi::NARSIL_FILTER_POLYGON,
            &numbers,
            inside,
            joined,
        );
    }
}

fn text_range(
    node: &FieldNode,
    lower: Option<TextBound<'_>>,
    upper: Option<TextBound<'_>>,
    program: &mut FilterProgram<'_>,
    joined: &mut Conjunction,
) -> Result<()> {
    let bits = text_range_bits(
        program.entry(),
        &node.path,
        lower.as_ref(),
        upper.as_ref(),
        program.live(),
    )?;
    program.bitset(bits);
    joined.append(program);
    Ok(())
}

fn text_range_plan(
    node: &FieldNode,
    program: &mut FilterProgram<'_>,
    joined: &mut Conjunction,
) -> Result<()> {
    for operator in TEXT_RANGE_OPERATORS {
        let Some(bound) = text(&node.tests, operator) else {
            continue;
        };
        let bound = Some(TextBound {
            text: bound,
            inclusive: matches!(operator, "gte" | "lte"),
        });
        match operator {
            "gt" | "gte" => text_range(node, bound, None, program, joined)?,
            _ => text_range(node, None, bound, program, joined)?,
        }
    }
    if let Some(Value::Array(bounds)) = node.tests.get("between") {
        if let [Value::String(low), Value::String(high)] = bounds.as_slice() {
            let lower = TextBound {
                text: low,
                inclusive: true,
            };
            let upper = TextBound {
                text: high,
                inclusive: true,
            };
            text_range(node, Some(lower), Some(upper), program, joined)?;
        }
    }
    Ok(())
}

fn field_plan(node: &FieldNode, program: &mut FilterProgram<'_>) -> Result<()> {
    let field = program.field(&node.path, node.base, false)?;
    let mut joined = Conjunction::default();
    presence_plan(node, field, program, &mut joined)?;
    location_plan(node, field, program, &mut joined);
    text_range_plan(node, program, &mut joined)?;
    if node.pattern {
        pattern_plan(node, field, program, &mut joined)?;
    } else if matches!(
        node.base,
        BaseType::Number
            | BaseType::NumberList
            | BaseType::Boolean
            | BaseType::BooleanList
            | BaseType::Enum
            | BaseType::EnumList
    ) {
        value_plan(node, field, program, &mut joined);
    }
    element_plan(node, field, program, &mut joined)?;
    size_plan(node, field, program, &mut joined)?;
    joined.finish(program);
    Ok(())
}
