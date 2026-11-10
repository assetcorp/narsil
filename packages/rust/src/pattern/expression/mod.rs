pub(crate) mod ast;
mod number_range;
mod parse_regex;
mod parse_set;
mod parse_wildcard;
mod positions;

use self::ast::{ParseFailure, code_points_of};
use self::parse_regex::RegexReader;
use self::parse_wildcard::parse_wildcard;
use self::positions::pattern_positions;
use super::constants::MAX_PATTERN_POSITIONS;
use crate::error::{ErrorCode, NarsilError, Result};

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

fn describe(operator: ExpressionOperator, field_path: &str) -> String {
    format!(
        "the \"{}\" pattern on pattern field \"{field_path}\"",
        operator.as_str()
    )
}

fn refused(operator: ExpressionOperator, field_path: &str, failure: ParseFailure) -> NarsilError {
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

pub(crate) fn check_expression(
    operator: ExpressionOperator,
    text: &str,
    case_fold: bool,
    field_path: &str,
) -> Result<()> {
    let code_points = code_points_of(text);
    let parsed = match operator {
        ExpressionOperator::Regex => RegexReader::parse(&code_points),
        ExpressionOperator::Wildcard => parse_wildcard(&code_points),
    };
    let node = parsed.map_err(|failure| refused(operator, field_path, failure))?;
    if pattern_positions(&node, case_fold) <= u64::from(MAX_PATTERN_POSITIONS) {
        return Ok(());
    }
    let folded = if case_fold {
        " once the engine folds its case"
    } else {
        ""
    };
    Err(NarsilError::new(
        ErrorCode::SEARCH_INVALID_FILTER,
        format!(
            "The engine refuses {} before it builds a matcher, because the pattern holds more than {MAX_PATTERN_POSITIONS} positions{folded}. A literal code point, a class, and a set each count as one position. A count such as {{5}} multiplies the positions of what it repeats. A number range counts the positions of the pattern that it stands for",
            describe(operator, field_path)
        ),
    ))
}
