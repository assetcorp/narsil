use std::collections::HashMap;
use std::sync::Arc;

use super::automaton::{BEFORE_VALUE_START, PatternProgram};
use super::constants::{
    MATCHER_EDGE_SLOT_BYTES, MATCHER_MIN_CODE_POINTS_PER_STATE, MATCHER_POSITION_BYTES,
    MATCHER_SPARSE_EDGE_BYTES, MATCHER_STATE_OVERHEAD_BYTES, MAX_DENSE_EDGE_CLASSES,
};
use super::meter::WorkTally;
use super::simulation::{PositionSimulation, Step};
use crate::error::Result;

const UNKNOWN_EDGE: u64 = 0;
const MATCHED_TARGET: u32 = 1;
const DEAD_TARGET: u32 = 2;
const FIRST_STATE_TARGET: u32 = 3;
const START_STATE: u32 = 0;

fn packed_edge(target: u32, steps: usize) -> u64 {
    (u64::from(steps.min(u32::MAX as usize) as u32) << 32) | u64::from(target)
}

fn edge_target(edge: u64) -> u32 {
    edge as u32
}

fn edge_steps(edge: u64) -> u64 {
    edge >> 32
}

struct DfaState {
    previous_kind: u8,
    positions: Box<[u32]>,
    end_match: Option<bool>,
}

pub(crate) struct LazyDfa {
    simulation: PositionSimulation,
    states: Vec<DfaState>,
    lookup: HashMap<Box<[u32]>, u32>,
    dense: Vec<u64>,
    sparse: HashMap<(u32, u32), u64>,
    dense_classes: usize,
    cached_bytes: usize,
    limit_bytes: usize,
    code_points_since_reset: usize,
    generation: u64,
    state: u32,
    simulating: bool,
    decided: Option<bool>,
}

fn state_key(previous_kind: u8, positions: &[u32]) -> Box<[u32]> {
    let mut key = Vec::with_capacity(positions.len() + 1);
    key.push(u32::from(previous_kind));
    key.extend_from_slice(positions);
    key.into_boxed_slice()
}

impl LazyDfa {
    pub(crate) fn new(program: Arc<PatternProgram>, limit_bytes: usize) -> LazyDfa {
        let class_count = program.classes.count();
        let dense_classes = if class_count <= MAX_DENSE_EDGE_CLASSES {
            class_count
        } else {
            0
        };
        let mut dfa = LazyDfa {
            simulation: PositionSimulation::new(program),
            states: Vec::new(),
            lookup: HashMap::new(),
            dense: Vec::new(),
            sparse: HashMap::new(),
            dense_classes,
            cached_bytes: 0,
            limit_bytes,
            code_points_since_reset: 0,
            generation: 0,
            state: START_STATE,
            simulating: false,
            decided: None,
        };
        dfa.restart_cache();
        dfa
    }

    pub(crate) fn program(&self) -> &Arc<PatternProgram> {
        self.simulation.program()
    }

    pub(crate) fn begin(&mut self) -> bool {
        self.decided = None;
        self.state = START_STATE;
        self.simulating = self.states.is_empty();
        if self.simulating {
            self.simulation.reset();
        }
        true
    }

    pub(crate) fn feed(&mut self, code_point: u32, tally: &mut WorkTally<'_>) -> Result<bool> {
        if self.simulating {
            let outcome = self.simulation.step(code_point);
            tally.add(self.simulation.steps as u64)?;
            return Ok(self.settle(outcome));
        }
        self.code_points_since_reset += 1;
        let class = self.simulation.program().classes.class_of(code_point);
        let slot = self.dense_slot(self.state, class);
        let cached = match slot {
            Some(slot) => self.dense.get(slot).copied().unwrap_or(UNKNOWN_EDGE),
            None => self
                .sparse
                .get(&(self.state, class))
                .copied()
                .unwrap_or(UNKNOWN_EDGE),
        };
        if cached != UNKNOWN_EDGE {
            tally.add(edge_steps(cached))?;
            return Ok(self.follow(edge_target(cached)));
        }
        let from = self.state as usize;
        let Some(state) = self.states.get(from) else {
            self.simulating = true;
            return Ok(true);
        };
        let previous_kind = state.previous_kind;
        let generation = self.generation;
        let positions = std::mem::take(&mut self.states[from].positions);
        self.simulation.load(&positions, previous_kind);
        self.states[from].positions = positions;
        let outcome = self.simulation.step(code_point);
        let steps = self.simulation.steps;
        tally.add(steps as u64)?;
        let target = match outcome {
            Step::Matched => MATCHED_TARGET,
            Step::Dead => DEAD_TARGET,
            Step::Continues => {
                self.simulation.sort_after();
                match self.intern_current() {
                    Some(id) => FIRST_STATE_TARGET + id,
                    None => {
                        self.simulating = true;
                        return Ok(true);
                    }
                }
            }
        };
        if self.generation == generation && self.try_reserve(MATCHER_SPARSE_EDGE_BYTES) {
            let edge = packed_edge(target, steps);
            match self.dense_slot(from as u32, class) {
                Some(slot) => {
                    if let Some(entry) = self.dense.get_mut(slot) {
                        *entry = edge;
                    }
                }
                None => {
                    self.sparse.insert((from as u32, class), edge);
                }
            }
        }
        Ok(self.follow(target))
    }

    pub(crate) fn matched(&mut self) -> bool {
        if let Some(decided) = self.decided {
            return decided;
        }
        if self.simulating {
            return self.simulation.end_matches();
        }
        let index = self.state as usize;
        let Some(state) = self.states.get(index) else {
            return false;
        };
        if let Some(known) = state.end_match {
            return known;
        }
        let previous_kind = state.previous_kind;
        let positions = std::mem::take(&mut self.states[index].positions);
        self.simulation.load(&positions, previous_kind);
        self.states[index].positions = positions;
        let outcome = self.simulation.end_matches();
        self.states[index].end_match = Some(outcome);
        outcome
    }

    fn settle(&mut self, outcome: Step) -> bool {
        match outcome {
            Step::Matched => {
                self.decided = Some(true);
                false
            }
            Step::Dead => {
                self.decided = Some(false);
                false
            }
            Step::Continues => true,
        }
    }

    fn follow(&mut self, target: u32) -> bool {
        match target {
            MATCHED_TARGET => self.settle(Step::Matched),
            DEAD_TARGET => self.settle(Step::Dead),
            _ => {
                self.state = target - FIRST_STATE_TARGET;
                true
            }
        }
    }

    fn dense_slot(&self, state: u32, class: u32) -> Option<usize> {
        let class = class as usize;
        (class < self.dense_classes).then(|| state as usize * self.dense_classes + class)
    }

    fn state_bytes(&self, positions: usize) -> usize {
        MATCHER_STATE_OVERHEAD_BYTES
            + (positions + 1) * MATCHER_POSITION_BYTES * 2
            + self.dense_classes * MATCHER_EDGE_SLOT_BYTES
    }

    fn intern_current(&mut self) -> Option<u32> {
        let previous_kind = self.simulation.previous_kind;
        let key = state_key(previous_kind, self.simulation.after());
        if let Some(&id) = self.lookup.get(&key) {
            return Some(id);
        }
        let bytes = self.state_bytes(key.len());
        if !self.reserve(bytes) {
            return None;
        }
        Some(self.push_state(key, previous_kind))
    }

    fn push_state(&mut self, key: Box<[u32]>, previous_kind: u8) -> u32 {
        let id = self.states.len() as u32;
        self.states.push(DfaState {
            previous_kind,
            positions: key.get(1..).unwrap_or(&[]).into(),
            end_match: None,
        });
        self.dense
            .extend(std::iter::repeat_n(UNKNOWN_EDGE, self.dense_classes));
        self.lookup.insert(key, id);
        id
    }

    fn try_reserve(&mut self, bytes: usize) -> bool {
        if self.cached_bytes + bytes > self.limit_bytes {
            return false;
        }
        self.cached_bytes += bytes;
        true
    }

    fn reserve(&mut self, bytes: usize) -> bool {
        if self.try_reserve(bytes) {
            return true;
        }
        let states = self.states.len();
        if states == 0 || self.code_points_since_reset < MATCHER_MIN_CODE_POINTS_PER_STATE * states
        {
            return false;
        }
        self.restart_cache();
        self.state = START_STATE;
        !self.states.is_empty() && self.try_reserve(bytes)
    }

    fn restart_cache(&mut self) {
        self.generation += 1;
        self.states.clear();
        self.lookup.clear();
        self.dense.clear();
        self.sparse.clear();
        self.cached_bytes = 0;
        self.code_points_since_reset = 0;
        let key = state_key(BEFORE_VALUE_START, &[]);
        let bytes = self.state_bytes(key.len());
        if bytes <= self.limit_bytes {
            self.cached_bytes = bytes;
            self.push_state(key, BEFORE_VALUE_START);
        }
    }
}
