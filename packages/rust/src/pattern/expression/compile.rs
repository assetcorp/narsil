use std::collections::{BTreeSet, HashSet};

use super::ast::ANY_CONTEXT_MASK;
use super::code_point_tests::CodePointTest;
use super::lower::{Consume, Plan};
use crate::pattern::automaton::{
    AFTER_VALUE_END, ASSERT_STATE, Accept, CONSUME_STATE, Closure, ClosureScratch,
    CodePointClasses, MATCH_STATE, OTHER_CODE_POINT, PatternProgram, SPLIT_STATE, UNSET,
    WORD_CODE_POINT, WORD_KIND_EDGES, close_over, context_of,
};

#[derive(Default)]
struct ProgramBuilder {
    kinds: Vec<u8>,
    next: Vec<u32>,
    alternative: Vec<u32>,
    masks: Vec<u16>,
    accepts: Vec<Option<Accept>>,
    positions: usize,
}

fn accept_of(consume: Consume) -> Accept {
    match consume {
        Consume::CodePoint(code_point) => Accept::CodePoint(code_point),
        Consume::Any => Accept::Any,
        Consume::Tested(test) => Accept::Tested(test),
    }
}

impl ProgramBuilder {
    fn add(&mut self, kind: u8, next: u32, alternative: u32, mask: u16) -> u32 {
        self.kinds.push(kind);
        self.next.push(next);
        self.alternative.push(alternative);
        self.masks.push(mask);
        self.accepts.push(None);
        (self.kinds.len() - 1) as u32
    }

    fn consume(&mut self, consume: Consume, next: u32) -> u32 {
        let state = self.add(CONSUME_STATE, next, UNSET, 0);
        self.accepts[state as usize] = Some(accept_of(consume));
        self.positions += 1;
        state
    }

    fn split(&mut self, first: u32, second: u32) -> u32 {
        self.add(SPLIT_STATE, first, second, 0)
    }

    fn compile(&mut self, plan: &Plan, next: u32) -> u32 {
        match plan {
            Plan::Consume(consume) => self.consume(*consume, next),
            Plan::Assert(mask) => {
                if *mask == ANY_CONTEXT_MASK {
                    next
                } else {
                    self.add(ASSERT_STATE, next, UNSET, *mask)
                }
            }
            Plan::Sequence(items) => {
                let mut entry = next;
                for item in items.iter().rev() {
                    entry = self.compile(item, entry);
                }
                entry
            }
            Plan::Choice(branches) => {
                let Some((last, rest)) = branches.split_last() else {
                    return next;
                };
                let mut entry = self.compile(last, next);
                for branch in rest.iter().rev() {
                    let first = self.compile(branch, next);
                    entry = self.split(first, entry);
                }
                entry
            }
            Plan::Repeat { body, min, max } => self.compile_repeat(body, *min, *max, next),
        }
    }

    fn compile_loop(&mut self, body: &Plan, next: u32, enters_body: bool) -> u32 {
        let loop_state = self.split(UNSET, next);
        let entry = self.compile(body, loop_state);
        self.next[loop_state as usize] = entry;
        if enters_body { entry } else { loop_state }
    }

    fn compile_repeat(&mut self, body: &Plan, min: u32, max: Option<u32>, next: u32) -> u32 {
        let mut required = min;
        let mut entry;
        match max {
            None => {
                entry = self.compile_loop(body, next, min > 0);
                if min > 0 {
                    required -= 1;
                }
            }
            Some(max) => {
                entry = next;
                for _ in 0..max.saturating_sub(min) {
                    let first = self.compile(body, entry);
                    entry = self.split(first, next);
                }
            }
        }
        for _ in 0..required {
            entry = self.compile(body, entry);
        }
        entry
    }
}

fn collect_class_edges(
    plan: &Plan,
    tests: &[CodePointTest],
    edges: &mut BTreeSet<u32>,
    seen: &mut HashSet<usize>,
) {
    match plan {
        Plan::Consume(Consume::CodePoint(code_point)) => {
            edges.insert(*code_point);
            edges.insert(code_point.saturating_add(1));
        }
        Plan::Consume(Consume::Tested(index)) => {
            if !seen.insert(*index) {
                return;
            }
            if let Some(test) = tests.get(*index) {
                for pair in test.ranges.chunks_exact(2) {
                    edges.insert(pair[0]);
                    edges.insert(pair[1].saturating_add(1));
                }
            }
        }
        Plan::Consume(Consume::Any) | Plan::Assert(_) => {}
        Plan::Sequence(children) | Plan::Choice(children) => {
            for child in children {
                collect_class_edges(child, tests, edges, seen);
            }
        }
        Plan::Repeat { body, .. } => collect_class_edges(body, tests, edges, seen),
    }
}

fn plan_classes(plan: &Plan, tests: &[CodePointTest]) -> CodePointClasses {
    let mut edges: BTreeSet<u32> = WORD_KIND_EDGES.iter().copied().collect();
    let mut seen = HashSet::new();
    collect_class_edges(plan, tests, &mut edges, &mut seen);
    let checks_fold_targets = seen.iter().any(|&index| {
        tests
            .get(index)
            .is_some_and(CodePointTest::checks_fold_targets)
    });
    CodePointClasses::new(edges.into_iter().collect(), checks_fold_targets)
}

fn starts_only_at_start(program: &PatternProgram) -> bool {
    let mut scratch = ClosureScratch::new(program.states());
    let mut candidates = Vec::with_capacity(program.positions);
    for previous in [WORD_CODE_POINT, OTHER_CODE_POINT] {
        for following in [AFTER_VALUE_END, WORD_CODE_POINT, OTHER_CODE_POINT] {
            let context = context_of(previous, following);
            match close_over(program, &[], true, context, &mut scratch, &mut candidates) {
                Closure::Matched => return false,
                Closure::Reached(count) if count > 0 => return false,
                Closure::Reached(_) => {}
            }
        }
    }
    true
}

pub(crate) fn compile_program(plan: &Plan, tests: Vec<CodePointTest>) -> PatternProgram {
    let mut builder = ProgramBuilder::default();
    let matched = builder.add(MATCH_STATE, UNSET, UNSET, 0);
    let start = builder.compile(plan, matched);
    let count = builder.kinds.len();
    let mut renumbered = vec![0u32; count];
    let mut next_position = 0u32;
    let mut next_other = builder.positions as u32;
    for (state, kind) in builder.kinds.iter().enumerate() {
        if *kind == CONSUME_STATE {
            renumbered[state] = next_position;
            next_position += 1;
        } else {
            renumbered[state] = next_other;
            next_other += 1;
        }
    }
    let remap = |state: u32| {
        if state == UNSET {
            UNSET
        } else {
            renumbered[state as usize]
        }
    };
    let mut kinds = vec![0u8; count];
    let mut next = vec![UNSET; count];
    let mut alternative = vec![UNSET; count];
    let mut masks = vec![0u16; count];
    let mut accepts = vec![Accept::Any; builder.positions];
    for (state, &target) in renumbered.iter().enumerate().take(count) {
        let target = target as usize;
        kinds[target] = builder.kinds[state];
        next[target] = remap(builder.next[state]);
        alternative[target] = remap(builder.alternative[state]);
        masks[target] = builder.masks[state];
        if let (Some(slot), Some(accept)) = (accepts.get_mut(target), builder.accepts[state]) {
            *slot = accept;
        }
    }
    let classes = plan_classes(plan, &tests);
    let mut program = PatternProgram {
        positions: builder.positions,
        kinds,
        next,
        alternative,
        masks,
        accepts,
        tests,
        start: remap(start),
        anchored_start: false,
        classes,
    };
    program.anchored_start = starts_only_at_start(&program);
    program
}
