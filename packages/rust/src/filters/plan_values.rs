use std::collections::HashSet;

use super::plan::{Conjunction, and_not, flag, text};
use super::program::FilterProgram;
use super::source::{and_into, empty_bits, is_empty_bits};
use super::tree::FieldNode;
use crate::error::Result;
use crate::ffi;
use crate::pattern::{PatternOperator, PatternTest, PatternTolerance};
use crate::schema::BaseType;
use crate::value::{Map, Value};

const NUMBER_RANGES: [(&str, u32); 4] = [
    ("gt", ffi::NARSIL_FILTER_GT),
    ("gte", ffi::NARSIL_FILTER_GTE),
    ("lt", ffi::NARSIL_FILTER_LT),
    ("lte", ffi::NARSIL_FILTER_LTE),
];
const SINGLE_TEXT_PATTERN_OPERATORS: [(&str, PatternOperator); 5] = [
    ("startsWith", PatternOperator::StartsWith),
    ("endsWith", PatternOperator::EndsWith),
    ("contains", PatternOperator::Contains),
    ("wildcard", PatternOperator::Wildcard),
    ("regex", PatternOperator::Regex),
];
const EXACT: PatternTolerance = PatternTolerance::Fixed(0);

fn distinct_texts(operand: Option<&Value>) -> Vec<&str> {
    let mut seen = HashSet::new();
    match operand {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|text| seen.insert(*text))
            .collect(),
        _ => Vec::new(),
    }
}

fn scalar_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => Some(*number),
        Value::Bool(flag) => Some(f64::from(u8::from(*flag))),
        _ => None,
    }
}

fn distinct_numbers(operand: Option<&Value>) -> Vec<f64> {
    let mut seen = HashSet::new();
    match operand {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(scalar_number)
            .filter(|number| seen.insert(if *number == 0.0 { 0 } else { number.to_bits() }))
            .collect(),
        _ => Vec::new(),
    }
}

fn tolerance_of(tests: &Map) -> PatternTolerance {
    match tests.get("tolerance") {
        Some(Value::String(text)) if text == "auto" => PatternTolerance::Auto,
        Some(Value::Number(count)) if (0.0..=2.0).contains(count) && count.fract() == 0.0 => {
            PatternTolerance::Fixed(*count as u32)
        }
        _ => EXACT,
    }
}

fn matched(
    program: &mut FilterProgram<'_>,
    path: &str,
    operator: PatternOperator,
    texts: &[&str],
    case_fold: bool,
    tolerance: PatternTolerance,
) -> Result<Vec<u32>> {
    let mut into = empty_bits(program.entry().capacity());
    for text in texts {
        let test = PatternTest {
            operator,
            text,
            case_fold,
            tolerance,
        };
        program.pattern_into(path, &test, &mut into)?;
    }
    Ok(into)
}

struct Pushed {
    field: u32,
    exclude: bool,
}

impl Pushed {
    fn of(field: u32, exclude: bool) -> Pushed {
        Pushed { field, exclude }
    }

    fn push<'s>(
        &self,
        program: &mut FilterProgram<'s>,
        joined: &mut Conjunction,
        test: impl FnOnce(&mut FilterProgram<'s>),
    ) {
        if self.exclude {
            program.emit(ffi::NARSIL_FILTER_PRESENT, self.field, 0, 0);
        }
        test(program);
        if self.exclude {
            and_not(program);
        }
        joined.append(program);
    }
}

pub(super) fn pattern_plan(
    node: &FieldNode,
    field: u32,
    program: &mut FilterProgram<'_>,
    joined: &mut Conjunction,
) -> Result<()> {
    let tests = &node.tests;
    let case_fold = flag(tests, "caseFold") == Some(true);
    let mut planned: Vec<(Vec<&str>, PatternOperator, PatternTolerance, bool)> = Vec::new();
    if let Some(eq) = text(tests, "eq") {
        planned.push((vec![eq], PatternOperator::Eq, tolerance_of(tests), false));
    }
    if let Some(ne) = text(tests, "ne") {
        planned.push((vec![ne], PatternOperator::Eq, EXACT, true));
    }
    for (operator, exclude) in [("in", false), ("nin", true)] {
        if tests.get(operator).is_some() {
            planned.push((
                distinct_texts(tests.get(operator)),
                PatternOperator::Eq,
                EXACT,
                exclude,
            ));
        }
    }
    for (name, operator) in SINGLE_TEXT_PATTERN_OPERATORS {
        if let Some(operand) = text(tests, name) {
            planned.push((vec![operand], operator, EXACT, false));
        }
    }
    for (texts, operator, tolerance, exclude) in planned {
        let bits = matched(program, &node.path, operator, &texts, case_fold, tolerance)?;
        Pushed::of(field, exclude).push(program, joined, |program| program.bitset(bits));
    }
    Ok(())
}

fn comparisons(
    tests: &Map,
    field: u32,
    target: u32,
    program: &mut FilterProgram<'_>,
    joined: &mut Conjunction,
) {
    for (operator, opcode) in NUMBER_RANGES {
        if let Some(Value::Number(bound)) = tests.get(operator) {
            Pushed::of(field, false).push(program, joined, |program| {
                program.test_numbers(target, opcode, &[*bound])
            });
        }
    }
    if let Some(Value::Array(bounds)) = tests.get("between") {
        if let [Value::Number(low), Value::Number(high)] = bounds.as_slice() {
            Pushed::of(field, false).push(program, joined, |program| {
                program.test_numbers(target, ffi::NARSIL_FILTER_BETWEEN, &[*low, *high])
            });
        }
    }
    for (operator, exclude) in [("eq", false), ("ne", true)] {
        if let Some(Value::Number(value)) = tests.get(operator) {
            Pushed::of(field, exclude).push(program, joined, |program| {
                program.test_numbers(target, ffi::NARSIL_FILTER_EQ, &[*value])
            });
        }
    }
}

fn enum_plan(tests: &Map, field: u32, program: &mut FilterProgram<'_>, joined: &mut Conjunction) {
    for (operator, exclude) in [("eq", false), ("ne", true)] {
        if let Some(value) = text(tests, operator) {
            Pushed::of(field, exclude).push(program, joined, |program| {
                program.test_text(field, ffi::NARSIL_FILTER_EQ, value)
            });
        }
    }
    for (operator, exclude) in [("in", false), ("nin", true)] {
        if let Some(operand @ Value::Array(_)) = tests.get(operator) {
            let texts = distinct_texts(Some(operand));
            Pushed::of(field, exclude).push(program, joined, |program| {
                program.test_text_list(field, ffi::NARSIL_FILTER_ANY, &texts)
            });
        }
    }
    for (operator, opcode) in [
        ("startsWith", ffi::NARSIL_FILTER_PREFIX),
        ("endsWith", ffi::NARSIL_FILTER_SUFFIX),
    ] {
        if let Some(value) = text(tests, operator) {
            Pushed::of(field, false).push(program, joined, |program| {
                program.test_text(field, opcode, value)
            });
        }
    }
}

pub(super) fn value_plan(
    node: &FieldNode,
    field: u32,
    program: &mut FilterProgram<'_>,
    joined: &mut Conjunction,
) {
    let tests = &node.tests;
    match node.base {
        BaseType::Number | BaseType::NumberList => {
            comparisons(tests, field, field, program, joined)
        }
        BaseType::Boolean | BaseType::BooleanList => {
            for (operator, exclude) in [("eq", false), ("ne", true)] {
                if let Some(value) = flag(tests, operator) {
                    let number = f64::from(u8::from(value));
                    Pushed::of(field, exclude).push(program, joined, |program| {
                        program.test_numbers(field, ffi::NARSIL_FILTER_EQ, &[number])
                    });
                }
            }
        }
        _ => enum_plan(tests, field, program, joined),
    }
}

fn all_patterns(
    node: &FieldNode,
    texts: &[&str],
    program: &mut FilterProgram<'_>,
) -> Result<Vec<u32>> {
    let mut bits = program.present(&node.path, node.base);
    for text in texts {
        if is_empty_bits(&bits) {
            break;
        }
        let held = matched(
            program,
            &node.path,
            PatternOperator::Eq,
            &[text],
            false,
            EXACT,
        )?;
        and_into(&mut bits, &held);
    }
    Ok(bits)
}

pub(super) fn element_plan(
    node: &FieldNode,
    field: u32,
    program: &mut FilterProgram<'_>,
    joined: &mut Conjunction,
) -> Result<()> {
    let tests = &node.tests;
    for (operator, opcode) in [
        ("matchesAny", ffi::NARSIL_FILTER_ANY),
        ("containsAll", ffi::NARSIL_FILTER_ALL),
    ] {
        let Some(operand @ Value::Array(_)) = tests.get(operator) else {
            continue;
        };
        if node.pattern {
            let texts = distinct_texts(Some(operand));
            let bits = match opcode {
                ffi::NARSIL_FILTER_ALL => all_patterns(node, &texts, program)?,
                _ => matched(
                    program,
                    &node.path,
                    PatternOperator::Eq,
                    &texts,
                    false,
                    EXACT,
                )?,
            };
            program.bitset(bits);
        } else {
            if opcode == ffi::NARSIL_FILTER_ALL {
                program.emit(ffi::NARSIL_FILTER_PRESENT, field, 0, 0);
            }
            match node.base {
                BaseType::EnumList => {
                    program.test_text_list(field, opcode, &distinct_texts(Some(operand)))
                }
                _ => program.test_number_list(field, opcode, &distinct_numbers(Some(operand))),
            }
            if opcode == ffi::NARSIL_FILTER_ALL {
                program.emit(ffi::NARSIL_FILTER_AND, 0, 0, 2);
            }
        }
        joined.append(program);
    }
    Ok(())
}

pub(super) fn size_plan(
    node: &FieldNode,
    field: u32,
    program: &mut FilterProgram<'_>,
    joined: &mut Conjunction,
) -> Result<()> {
    if let Some(Value::Object(size)) = node.tests.get("size") {
        let sizes = program.field(&node.path, node.base, true)?;
        comparisons(size, field, sizes, program, joined);
    }
    Ok(())
}
