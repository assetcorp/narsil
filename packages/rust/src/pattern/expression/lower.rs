use super::ast::{ANY_CONTEXT_MASK, Node, SetItem};
use super::code_point_tests::{CodePointTest, class_test, distinct_multi_folds, set_test};
use crate::pattern::fold::fold;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Consume {
    CodePoint(u32),
    Any,
    Tested(usize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Plan {
    Consume(Consume),
    Assert(u16),
    Sequence(Vec<Plan>),
    Choice(Vec<Plan>),
    Repeat {
        body: Box<Plan>,
        min: u32,
        max: Option<u32>,
    },
}

const EMPTY: Plan = Plan::Assert(ANY_CONTEXT_MASK);

fn flatten_sequence(item: Plan, kept: &mut Vec<Plan>, mask: &mut u16) {
    match item {
        Plan::Sequence(items) => {
            for nested in items {
                flatten_sequence(nested, kept, mask);
            }
        }
        Plan::Assert(item_mask) => *mask &= item_mask,
        other => {
            if *mask != ANY_CONTEXT_MASK {
                kept.push(Plan::Assert(*mask));
            }
            *mask = ANY_CONTEXT_MASK;
            kept.push(other);
        }
    }
}

fn sequence_of(items: Vec<Plan>) -> Plan {
    let mut kept = Vec::new();
    let mut mask = ANY_CONTEXT_MASK;
    for item in items {
        flatten_sequence(item, &mut kept, &mut mask);
    }
    if kept.is_empty() {
        return Plan::Assert(mask);
    }
    if mask != ANY_CONTEXT_MASK {
        kept.push(Plan::Assert(mask));
    }
    if kept.len() == 1 {
        return kept.remove(0);
    }
    Plan::Sequence(kept)
}

fn flatten_choice(branch: Plan, kept: &mut Vec<Plan>, mask: &mut u16, empty: &mut bool) {
    match branch {
        Plan::Choice(branches) => {
            for nested in branches {
                flatten_choice(nested, kept, mask, empty);
            }
        }
        Plan::Assert(branch_mask) => {
            *mask |= branch_mask;
            *empty = true;
        }
        other => kept.push(other),
    }
}

fn choice_of(branches: Vec<Plan>) -> Plan {
    let mut kept = Vec::new();
    let mut mask = 0;
    let mut empty = false;
    for branch in branches {
        flatten_choice(branch, &mut kept, &mut mask, &mut empty);
    }
    if kept.is_empty() {
        return Plan::Assert(mask);
    }
    if empty {
        kept.push(Plan::Assert(mask));
    }
    if kept.len() == 1 {
        return kept.remove(0);
    }
    Plan::Choice(kept)
}

fn is_loose(min: u32, max: Option<u32>) -> bool {
    min <= 1 && (max.is_none() || max == Some(1))
}

fn repeat_of(body: Plan, min: u32, max: Option<u32>) -> Plan {
    if max == Some(0) {
        return EMPTY;
    }
    if let Plan::Assert(_) = body {
        return if min == 0 { EMPTY } else { body };
    }
    if min == 1 && max == Some(1) {
        return body;
    }
    if is_loose(min, max) {
        if let Plan::Repeat {
            body: inner,
            min: inner_min,
            max: inner_max,
        } = &body
        {
            if is_loose(*inner_min, *inner_max) {
                let nullable = min == 0 || *inner_min == 0;
                let unbounded = max.is_none() || inner_max.is_none();
                return Plan::Repeat {
                    body: inner.clone(),
                    min: u32::from(!nullable),
                    max: (!unbounded).then_some(1),
                };
            }
        }
    }
    Plan::Repeat {
        body: Box::new(body),
        min,
        max,
    }
}

fn literal_plan(code_point: u32) -> Plan {
    Plan::Consume(Consume::CodePoint(code_point))
}

pub(crate) struct Lowering {
    pub(crate) tests: Vec<CodePointTest>,
    case_fold: bool,
}

impl Lowering {
    fn tested(&mut self, test: CodePointTest) -> Plan {
        self.tests.push(test);
        Plan::Consume(Consume::Tested(self.tests.len() - 1))
    }

    fn set_plan(&mut self, negated: bool, items: &[SetItem]) -> Plan {
        let single = self.tested(set_test(items, negated, self.case_fold));
        if !self.case_fold || negated {
            return single;
        }
        let sequences: Vec<Plan> = distinct_multi_folds(items)
            .into_iter()
            .map(|each| sequence_of(each.into_iter().map(literal_plan).collect()))
            .collect();
        if sequences.is_empty() {
            return single;
        }
        let mut branches = Vec::with_capacity(sequences.len() + 1);
        branches.push(single);
        branches.extend(sequences);
        choice_of(branches)
    }

    fn lower(&mut self, node: &Node) -> Plan {
        match node {
            Node::Literal(code_point) => {
                if !self.case_fold {
                    return literal_plan(*code_point);
                }
                let folded = fold(*code_point);
                sequence_of(
                    folded
                        .as_slice()
                        .iter()
                        .map(|&each| literal_plan(each))
                        .collect(),
                )
            }
            Node::Any => Plan::Consume(Consume::Any),
            Node::Class(name) => self.tested(class_test(*name)),
            Node::Set { negated, items } => self.set_plan(*negated, items),
            Node::Assert(mask) => Plan::Assert(*mask),
            Node::Sequence(items) => {
                let lowered = items.iter().map(|item| self.lower(item)).collect();
                sequence_of(lowered)
            }
            Node::Choice(branches) => {
                let lowered = branches.iter().map(|branch| self.lower(branch)).collect();
                choice_of(lowered)
            }
            Node::Repeat { body, min, max } => {
                let lowered = self.lower(body);
                repeat_of(lowered, *min, *max)
            }
            Node::NumberRange(expansion) => self.lower(expansion),
        }
    }
}

pub(crate) fn lower_pattern(node: &Node, case_fold: bool) -> (Plan, Vec<CodePointTest>) {
    let mut lowering = Lowering {
        tests: Vec::new(),
        case_fold,
    };
    let plan = lowering.lower(node);
    (plan, lowering.tests)
}
