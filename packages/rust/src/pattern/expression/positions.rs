use std::collections::HashSet;

use super::ast::{Node, SetItem};
use crate::error::Result;
use crate::pattern::constants::MAX_PATTERN_POSITIONS;
use crate::pattern::text::append_folded_code_point;

const SATURATED: u64 = MAX_PATTERN_POSITIONS as u64 + 1;

fn saturating(total: u64) -> u64 {
    total.min(SATURATED)
}

fn folded(code_point: u32) -> Result<Vec<u32>> {
    let mut fold = Vec::new();
    append_folded_code_point(code_point, &mut fold)?;
    Ok(fold)
}

fn distinct_multi_folds(items: &[SetItem]) -> Result<Vec<Vec<u32>>> {
    let mut seen: HashSet<Vec<u32>> = HashSet::new();
    let mut folds = Vec::new();
    for item in items {
        let SetItem::Member(code_point) = item else {
            continue;
        };
        let fold = folded(*code_point)?;
        if fold.len() < 2 || !seen.insert(fold.clone()) {
            continue;
        }
        folds.push(fold);
    }
    Ok(folds)
}

fn positions_of(node: &Node, case_fold: bool) -> Result<u64> {
    Ok(match node {
        Node::Literal(code_point) => {
            if case_fold {
                folded(*code_point)?.len() as u64
            } else {
                1
            }
        }
        Node::Any | Node::Class(_) => 1,
        Node::Set { negated, items } => {
            if !case_fold || *negated {
                return Ok(1);
            }
            let mut total = 1;
            for each in distinct_multi_folds(items)? {
                total = saturating(total + each.len() as u64);
            }
            total
        }
        Node::Assert(_) => 0,
        Node::Sequence(children) | Node::Choice(children) => {
            let mut total = 0;
            for child in children {
                total = saturating(total + positions_of(child, case_fold)?);
                if total == SATURATED {
                    return Ok(total);
                }
            }
            total
        }
        Node::Repeat { body, min, max } => {
            let copies = u64::from(max.unwrap_or_else(|| (*min).max(1)));
            saturating(copies * positions_of(body, case_fold)?)
        }
        Node::NumberRange(expansion) => positions_of(expansion, case_fold)?,
    })
}

pub(crate) fn pattern_positions(node: &Node, case_fold: bool) -> Result<u64> {
    positions_of(node, case_fold)
}
