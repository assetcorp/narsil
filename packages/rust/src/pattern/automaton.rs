use super::constants::DIRECT_CLASS_CODE_POINTS;
use super::expression::code_point_tests::CodePointTest;
use super::fold::is_fold_target;

pub(crate) const BEFORE_VALUE_START: u8 = 0;
pub(crate) const AFTER_VALUE_END: u8 = 0;
pub(crate) const WORD_CODE_POINT: u8 = 1;
pub(crate) const OTHER_CODE_POINT: u8 = 2;
const EDGE_KINDS: u8 = 3;

pub(crate) const CONSUME_STATE: u8 = 0;
pub(crate) const SPLIT_STATE: u8 = 1;
pub(crate) const ASSERT_STATE: u8 = 2;
pub(crate) const MATCH_STATE: u8 = 3;

pub(crate) const UNSET: u32 = u32::MAX;

pub(crate) const WORD_KIND_EDGES: [u32; 8] = [0x30, 0x3a, 0x41, 0x5b, 0x5f, 0x60, 0x61, 0x7b];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Accept {
    CodePoint(u32),
    Any,
    Tested(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Closure {
    Matched,
    Reached(usize),
}

pub(crate) struct CodePointClasses {
    pub(crate) starts: Vec<u32>,
    pub(crate) checks_fold_targets: bool,
    pub(crate) direct: Vec<u32>,
}

pub(crate) const FOLD_TARGET_CLASS_FLAG: u32 = 0x8000_0000;

fn searched_class(starts: &[u32], checks_fold_targets: bool, code_point: u32) -> u32 {
    if checks_fold_targets && is_fold_target(code_point) {
        return FOLD_TARGET_CLASS_FLAG | code_point;
    }
    starts.partition_point(|&start| start <= code_point) as u32
}

impl CodePointClasses {
    pub(crate) fn new(starts: Vec<u32>, checks_fold_targets: bool) -> CodePointClasses {
        let direct = (0..DIRECT_CLASS_CODE_POINTS as u32)
            .map(|code_point| searched_class(&starts, checks_fold_targets, code_point))
            .collect();
        CodePointClasses {
            starts,
            checks_fold_targets,
            direct,
        }
    }

    #[inline]
    pub(crate) fn class_of(&self, code_point: u32) -> u32 {
        match self.direct.get(code_point as usize) {
            Some(&class) => class,
            None => searched_class(&self.starts, self.checks_fold_targets, code_point),
        }
    }

    pub(crate) fn count(&self) -> usize {
        self.starts.len() + 1
    }
}

pub(crate) struct PatternProgram {
    pub(crate) positions: usize,
    pub(crate) kinds: Vec<u8>,
    pub(crate) next: Vec<u32>,
    pub(crate) alternative: Vec<u32>,
    pub(crate) masks: Vec<u16>,
    pub(crate) accepts: Vec<Accept>,
    pub(crate) tests: Vec<CodePointTest>,
    pub(crate) start: u32,
    pub(crate) anchored_start: bool,
    pub(crate) classes: CodePointClasses,
}

#[inline]
pub(crate) fn is_word_code_point(code_point: u32) -> bool {
    matches!(code_point, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x5f)
}

#[inline]
pub(crate) fn kind_of(code_point: u32) -> u8 {
    if is_word_code_point(code_point) {
        WORD_CODE_POINT
    } else {
        OTHER_CODE_POINT
    }
}

#[inline]
pub(crate) fn context_of(previous: u8, next: u8) -> u8 {
    previous * EDGE_KINDS + next
}

impl PatternProgram {
    pub(crate) fn states(&self) -> usize {
        self.kinds.len()
    }

    #[inline]
    pub(crate) fn accepts(&self, position: u32, code_point: u32) -> bool {
        match self.accepts.get(position as usize) {
            Some(Accept::CodePoint(literal)) => *literal == code_point,
            Some(Accept::Any) => true,
            Some(Accept::Tested(test)) => self
                .tests
                .get(*test)
                .is_some_and(|test| test.has(code_point)),
            None => false,
        }
    }
}

pub(crate) struct ClosureScratch {
    marks: Vec<u32>,
    stack: Vec<u32>,
    stamp: u32,
}

impl ClosureScratch {
    pub(crate) fn new(states: usize) -> ClosureScratch {
        ClosureScratch {
            marks: vec![0; states],
            stack: Vec::with_capacity(states),
            stamp: 0,
        }
    }

    fn next_stamp(&mut self) -> u32 {
        if self.stamp == u32::MAX {
            self.marks.fill(0);
            self.stamp = 0;
        }
        self.stamp += 1;
        self.stamp
    }

    #[inline]
    pub(crate) fn mark_if_new(&mut self, state: u32) -> bool {
        match self.marks.get_mut(state as usize) {
            Some(mark) if *mark != self.stamp => {
                *mark = self.stamp;
                true
            }
            _ => false,
        }
    }
}

pub(crate) fn close_over(
    program: &PatternProgram,
    seeds: &[u32],
    from_start: bool,
    context: u8,
    scratch: &mut ClosureScratch,
    out: &mut Vec<u32>,
) -> Closure {
    scratch.next_stamp();
    scratch.stack.clear();
    out.clear();
    for &seed in seeds {
        let Some(&state) = program.next.get(seed as usize) else {
            continue;
        };
        if scratch.mark_if_new(state) {
            scratch.stack.push(state);
        }
    }
    if from_start && scratch.mark_if_new(program.start) {
        scratch.stack.push(program.start);
    }
    while let Some(state) = scratch.stack.pop() {
        let index = state as usize;
        let kind = program.kinds[index];
        if kind == CONSUME_STATE {
            out.push(state);
            continue;
        }
        if kind == MATCH_STATE {
            return Closure::Matched;
        }
        if kind == ASSERT_STATE && (program.masks[index] >> context) & 1 == 0 {
            continue;
        }
        let following = program.next[index];
        if scratch.mark_if_new(following) {
            scratch.stack.push(following);
        }
        if kind != SPLIT_STATE {
            continue;
        }
        let other = program.alternative[index];
        if scratch.mark_if_new(other) {
            scratch.stack.push(other);
        }
    }
    Closure::Reached(out.len())
}
