use std::collections::HashSet;

use super::ast::Node;
use crate::pattern::constants::{PATTERN_RUN_CODE_POINTS, SHORTLIST_RUN_LOOKUPS};
use crate::pattern::fold::append_fold;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RunQuery {
    All(Vec<u32>),
    Any(Vec<Vec<u32>>),
}

struct FactorCollector {
    factors: Vec<Vec<u32>>,
    current: Vec<u32>,
}

impl FactorCollector {
    fn flush(&mut self) {
        let current = std::mem::take(&mut self.current);
        if current.len() >= PATTERN_RUN_CODE_POINTS {
            self.factors.push(current);
        }
    }

    fn visit(&mut self, node: &Node) {
        match node {
            Node::Literal(code_point) => append_fold(*code_point, &mut self.current),
            Node::Assert(_) => {}
            Node::Sequence(items) => {
                for item in items {
                    self.visit(item);
                }
            }
            Node::Repeat { body, min, max } => {
                if *min == 1 && *max == Some(1) {
                    self.visit(body);
                    return;
                }
                self.flush();
                if *min >= 1 {
                    self.visit(body);
                    self.flush();
                }
            }
            _ => self.flush(),
        }
    }
}

fn runs_in(factor: &[u32]) -> usize {
    (factor.len() + 1).saturating_sub(PATTERN_RUN_CODE_POINTS)
}

fn rounded_quotient(numerator: usize, denominator: usize) -> usize {
    (2 * numerator + denominator) / (2 * denominator)
}

pub(crate) fn spread_runs(factors: &[Vec<u32>]) -> Vec<u32> {
    let total: usize = factors.iter().map(|factor| runs_in(factor)).sum();
    if total == 0 {
        return Vec::new();
    }
    let picks = total.min(SHORTLIST_RUN_LOOKUPS);
    let mut seen: HashSet<[u32; PATTERN_RUN_CODE_POINTS]> = HashSet::new();
    let mut runs = Vec::with_capacity(picks * PATTERN_RUN_CODE_POINTS);
    let mut factor_at = 0;
    let mut factor_start = 0;
    for pick in 0..picks {
        let target = if picks == 1 {
            0
        } else {
            rounded_quotient(pick * (total - 1), picks - 1)
        };
        let mut factor_runs = factors.get(factor_at).map_or(0, |factor| runs_in(factor));
        while target >= factor_start + factor_runs && factor_at + 1 < factors.len() {
            factor_start += factor_runs;
            factor_at += 1;
            factor_runs = runs_in(&factors[factor_at]);
        }
        let Some(factor) = factors.get(factor_at) else {
            break;
        };
        let at = target - factor_start;
        let Some(run) = factor.get(at..at + PATTERN_RUN_CODE_POINTS) else {
            break;
        };
        let key = [run[0], run[1], run[2]];
        if seen.insert(key) {
            runs.extend_from_slice(&key);
        }
    }
    runs
}

fn branch_runs(node: &Node) -> Vec<u32> {
    let mut collector = FactorCollector {
        factors: Vec::new(),
        current: Vec::new(),
    };
    collector.visit(node);
    collector.flush();
    spread_runs(&collector.factors)
}

pub(crate) fn required_runs(node: &Node) -> RunQuery {
    let Node::Choice(branches) = node else {
        return RunQuery::All(branch_runs(node));
    };
    let branches: Vec<Vec<u32>> = branches.iter().map(branch_runs).collect();
    if branches.iter().any(Vec::is_empty) {
        return RunQuery::All(Vec::new());
    }
    RunQuery::Any(branches)
}
