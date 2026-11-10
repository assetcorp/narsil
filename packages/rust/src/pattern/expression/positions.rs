use super::ast::Node;
use super::code_point_tests::distinct_multi_folds;
use crate::pattern::constants::MAX_PATTERN_POSITIONS;
use crate::pattern::fold::fold;

const SATURATED: u64 = MAX_PATTERN_POSITIONS as u64 + 1;

fn saturating(total: u64) -> u64 {
    total.min(SATURATED)
}

fn positions_of(node: &Node, case_fold: bool) -> u64 {
    match node {
        Node::Literal(code_point) => {
            if case_fold {
                fold(*code_point).len() as u64
            } else {
                1
            }
        }
        Node::Any | Node::Class(_) => 1,
        Node::Set { negated, items } => {
            if !case_fold || *negated {
                return 1;
            }
            let mut total = 1;
            for each in distinct_multi_folds(items) {
                total = saturating(total + each.len() as u64);
            }
            total
        }
        Node::Assert(_) => 0,
        Node::Sequence(children) | Node::Choice(children) => {
            let mut total = 0;
            for child in children {
                total = saturating(total + positions_of(child, case_fold));
                if total == SATURATED {
                    return total;
                }
            }
            total
        }
        Node::Repeat { body, min, max } => {
            let copies = u64::from(max.unwrap_or_else(|| (*min).max(1)));
            saturating(copies * positions_of(body, case_fold))
        }
        Node::NumberRange(expansion) => positions_of(expansion, case_fold),
    }
}

pub(crate) fn pattern_positions(node: &Node, case_fold: bool) -> u64 {
    positions_of(node, case_fold)
}
