use std::sync::Arc;

use super::automaton::{
    AFTER_VALUE_END, BEFORE_VALUE_START, Closure, ClosureScratch, PatternProgram, close_over,
    context_of, kind_of,
};

const CONTEXTS: usize = 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Step {
    Continues,
    Matched,
    Dead,
}

struct StartClosure {
    positions: Vec<u32>,
    matches: bool,
}

pub(crate) struct PositionSimulation {
    program: Arc<PatternProgram>,
    pub(crate) steps: usize,
    pub(crate) previous_kind: u8,
    after: Vec<u32>,
    candidates: Vec<u32>,
    scratch: ClosureScratch,
    starts: [Option<StartClosure>; CONTEXTS],
}

impl PositionSimulation {
    pub(crate) fn new(program: Arc<PatternProgram>) -> PositionSimulation {
        let positions = program.positions;
        let states = program.states();
        PositionSimulation {
            program,
            steps: 0,
            previous_kind: BEFORE_VALUE_START,
            after: Vec::with_capacity(positions),
            candidates: Vec::with_capacity(positions),
            scratch: ClosureScratch::new(states),
            starts: Default::default(),
        }
    }

    pub(crate) fn program(&self) -> &Arc<PatternProgram> {
        &self.program
    }

    pub(crate) fn reset(&mut self) {
        self.after.clear();
        self.previous_kind = BEFORE_VALUE_START;
    }

    pub(crate) fn load(&mut self, positions: &[u32], previous_kind: u8) {
        self.after.clear();
        self.after.extend_from_slice(positions);
        self.previous_kind = previous_kind;
    }

    pub(crate) fn after(&self) -> &[u32] {
        &self.after
    }

    pub(crate) fn sort_after(&mut self) {
        self.after.sort_unstable();
    }

    pub(crate) fn step(&mut self, code_point: u32) -> Step {
        let following = kind_of(code_point);
        let reached = match self.close(context_of(self.previous_kind, following)) {
            Closure::Matched => {
                self.steps = 0;
                return Step::Matched;
            }
            Closure::Reached(reached) => reached,
        };
        self.steps = reached;
        self.after.clear();
        for &position in &self.candidates {
            if self.program.accepts(position, code_point) {
                self.after.push(position);
            }
        }
        self.previous_kind = following;
        if self.after.is_empty() && self.program.anchored_start {
            return Step::Dead;
        }
        Step::Continues
    }

    pub(crate) fn end_matches(&mut self) -> bool {
        self.close(context_of(self.previous_kind, AFTER_VALUE_END)) == Closure::Matched
    }

    fn ensure_start_closure(&mut self, context: usize) {
        if self.starts[context].is_some() {
            return;
        }
        let closure = match close_over(
            &self.program,
            &[],
            true,
            context as u8,
            &mut self.scratch,
            &mut self.candidates,
        ) {
            Closure::Matched => StartClosure {
                positions: Vec::new(),
                matches: true,
            },
            Closure::Reached(_) => StartClosure {
                positions: self.candidates.clone(),
                matches: false,
            },
        };
        self.starts[context] = Some(closure);
    }

    fn close(&mut self, context: u8) -> Closure {
        let from_start = self.previous_kind == BEFORE_VALUE_START || !self.program.anchored_start;
        let slot = context as usize;
        if from_start {
            self.ensure_start_closure(slot);
            if self.starts[slot]
                .as_ref()
                .is_some_and(|start| start.matches)
            {
                return Closure::Matched;
            }
        }
        let reached = close_over(
            &self.program,
            &self.after,
            false,
            context,
            &mut self.scratch,
            &mut self.candidates,
        );
        if reached == Closure::Matched || !from_start {
            return reached;
        }
        if let Some(start) = &self.starts[slot] {
            for &position in &start.positions {
                if self.scratch.mark_if_new(position) {
                    self.candidates.push(position);
                }
            }
        }
        Closure::Reached(self.candidates.len())
    }
}
