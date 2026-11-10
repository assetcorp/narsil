pub(crate) mod ast;
pub(crate) mod code_point_tests;
mod compile;
mod lower;
mod number_range;
mod parse_regex;
mod parse_set;
mod parse_wildcard;
mod positions;
pub(crate) mod required_runs;

use std::sync::Arc;

use self::ast::{Node, ParseFailure, code_points_of};
use self::compile::compile_program;
use self::lower::lower_pattern;
use self::parse_regex::RegexReader;
use self::parse_wildcard::parse_wildcard;
use self::positions::pattern_positions;
use self::required_runs::{RunQuery, required_runs};
use super::automaton::PatternProgram;
use super::constants::MAX_PATTERN_POSITIONS;
use crate::error::{ErrorCode, NarsilError, Result};

pub(crate) use self::required_runs::spread_runs;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ExpressionOperator {
    Wildcard,
    Regex,
}

impl ExpressionOperator {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ExpressionOperator::Wildcard => "wildcard",
            ExpressionOperator::Regex => "regex",
        }
    }
}

pub(crate) struct CompiledExpression {
    pub(crate) program: Arc<PatternProgram>,
    pub(crate) runs: RunQuery,
}

fn describe(operator: ExpressionOperator, field_path: Option<&str>) -> String {
    match field_path {
        None => format!("the \"{}\" pattern", operator.as_str()),
        Some(path) => format!(
            "the \"{}\" pattern on pattern field \"{path}\"",
            operator.as_str()
        ),
    }
}

fn refused(
    operator: ExpressionOperator,
    field_path: Option<&str>,
    failure: ParseFailure,
) -> NarsilError {
    NarsilError::new(
        ErrorCode::SEARCH_INVALID_FILTER,
        format!(
            "The engine refuses {} at code point {}. The pattern {}",
            describe(operator, field_path),
            failure.at + 1,
            failure.reason
        ),
    )
}

fn parsed_within_limits(
    operator: ExpressionOperator,
    field_path: Option<&str>,
    text: &str,
    case_fold: bool,
) -> Result<Node> {
    let code_points = code_points_of(text);
    let parsed = match operator {
        ExpressionOperator::Regex => RegexReader::parse(&code_points),
        ExpressionOperator::Wildcard => parse_wildcard(&code_points),
    };
    let node = parsed.map_err(|failure| refused(operator, field_path, failure))?;
    if pattern_positions(&node, case_fold) > u64::from(MAX_PATTERN_POSITIONS) {
        let folded = if case_fold {
            " once the engine folds its case"
        } else {
            ""
        };
        return Err(NarsilError::new(
            ErrorCode::SEARCH_INVALID_FILTER,
            format!(
                "The engine refuses {} before it builds a matcher, because the pattern holds more than {MAX_PATTERN_POSITIONS} positions{folded}. A literal code point, a class, and a set each count as one position. A count such as {{5}} multiplies the positions of what it repeats. A number range counts the positions of the pattern that it stands for",
                describe(operator, field_path)
            ),
        ));
    }
    Ok(node)
}

pub(crate) fn check_expression(
    operator: ExpressionOperator,
    text: &str,
    case_fold: bool,
    field_path: &str,
) -> Result<()> {
    parsed_within_limits(operator, Some(field_path), text, case_fold).map(|_| ())
}

pub(crate) fn compile_expression(
    operator: ExpressionOperator,
    text: &str,
    case_fold: bool,
) -> Result<CompiledExpression> {
    let node = parsed_within_limits(operator, None, text, case_fold)?;
    let runs = required_runs(&node);
    let (plan, tests) = lower_pattern(&node, case_fold);
    let program = Arc::new(compile_program(&plan, tests));
    Ok(CompiledExpression { program, runs })
}
