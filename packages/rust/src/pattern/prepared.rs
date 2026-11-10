use super::constants::PATTERN_RUN_CODE_POINTS;
use super::expression::required_runs::RunQuery;
use super::expression::{CompiledExpression, ExpressionOperator, compile_expression, spread_runs};
use super::literal::LiteralMatcher;
use super::text::{append_text_code_points, folded_code_points};
use super::typo_text::{
    distinct_typo_runs, fold_typo_text, resolved_typo_tolerance, typo_run_limit, typo_runs_needed,
};
use crate::error::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum PatternOperator {
    Eq,
    StartsWith,
    EndsWith,
    Contains,
    Wildcard,
    Regex,
}

impl PatternOperator {
    fn anchored_start(self) -> bool {
        matches!(self, PatternOperator::Eq | PatternOperator::StartsWith)
    }

    fn anchored_end(self) -> bool {
        matches!(self, PatternOperator::Eq | PatternOperator::EndsWith)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum PatternTolerance {
    Fixed(u32),
    Auto,
}

impl PatternTolerance {
    pub(crate) fn as_text(self) -> String {
        match self {
            PatternTolerance::Fixed(count) => count.to_string(),
            PatternTolerance::Auto => "auto".to_string(),
        }
    }
}

pub(crate) struct TypoTest {
    pub(crate) needed: usize,
    pub(crate) runs: Vec<u32>,
    pub(crate) text: Vec<u32>,
    pub(crate) shortest: i64,
    pub(crate) longest: i64,
    pub(crate) case_fold: bool,
    pub(crate) tolerance: u32,
}

pub(crate) struct TypoPreparation {
    pub(crate) test: Option<TypoTest>,
    pub(crate) units: u64,
    pub(crate) claim_key: String,
}

pub(crate) struct LiteralTest {
    pub(crate) runs: RunQuery,
    pub(crate) matcher: LiteralMatcher,
}

pub(crate) enum PreparedMatch {
    Literal(LiteralTest),
    Expression(CompiledExpression),
}

pub(crate) struct PreparedPattern {
    pub(crate) case_fold: bool,
    pub(crate) typo: Option<TypoPreparation>,
    pub(crate) test: PreparedMatch,
}

fn prepare_typo_test(text: &str, case_fold: bool, tolerance: PatternTolerance) -> TypoPreparation {
    let mut units = 0u64;
    let typo_text = fold_typo_text(text, &mut units);
    let distinct = distinct_typo_runs(
        &typo_text,
        typo_run_limit(typo_text.longest_fold),
        &mut units,
    );
    let requested = match tolerance {
        PatternTolerance::Fixed(count) => Some(count),
        PatternTolerance::Auto => None,
    };
    let resolved = resolved_typo_tolerance(
        requested,
        typo_text.longest_fold,
        distinct.len() / PATTERN_RUN_CODE_POINTS,
    );
    let claim_key = format!("{case_fold}|{}|{text}", tolerance.as_text());
    if resolved == 0 {
        return TypoPreparation {
            test: None,
            units,
            claim_key,
        };
    }
    if case_fold {
        units += typo_text.folded.len() as u64;
    }
    let length = if case_fold {
        typo_text.folded.len()
    } else {
        typo_text.code_points
    } as i64;
    let compared = if case_fold {
        typo_text.folded.clone()
    } else {
        text.chars().map(|character| character as u32).collect()
    };
    TypoPreparation {
        test: Some(TypoTest {
            needed: typo_runs_needed(resolved, typo_text.longest_fold),
            runs: distinct,
            text: compared,
            shortest: length - i64::from(resolved),
            longest: length + i64::from(resolved),
            case_fold,
            tolerance: resolved,
        }),
        units,
        claim_key,
    }
}

fn literal_test(operator: PatternOperator, text: &str, case_fold: bool) -> LiteralTest {
    let runs = RunQuery::All(spread_runs(&[folded_code_points(text)]));
    let mut code_points = Vec::with_capacity(text.len());
    append_text_code_points(text, case_fold, &mut code_points);
    LiteralTest {
        runs,
        matcher: LiteralMatcher::new(
            code_points,
            operator.anchored_start(),
            operator.anchored_end(),
        ),
    }
}

pub(crate) fn prepare_pattern(
    operator: PatternOperator,
    text: &str,
    case_fold: bool,
    tolerance: PatternTolerance,
) -> Result<PreparedPattern> {
    let typo = (operator == PatternOperator::Eq && tolerance != PatternTolerance::Fixed(0))
        .then(|| prepare_typo_test(text, case_fold, tolerance));
    let test = match operator {
        PatternOperator::Wildcard => PreparedMatch::Expression(compile_expression(
            ExpressionOperator::Wildcard,
            text,
            case_fold,
        )?),
        PatternOperator::Regex => PreparedMatch::Expression(compile_expression(
            ExpressionOperator::Regex,
            text,
            case_fold,
        )?),
        _ => PreparedMatch::Literal(literal_test(operator, text, case_fold)),
    };
    Ok(PreparedPattern {
        case_fold,
        typo,
        test,
    })
}
