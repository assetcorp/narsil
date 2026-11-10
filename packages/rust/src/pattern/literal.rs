use super::meter::WorkTally;
use crate::error::Result;

fn borders_of(code_points: &[u32]) -> Vec<u32> {
    let length = code_points.len();
    let mut borders = vec![0u32; length + 1];
    let mut border = 0usize;
    for at in 1..length {
        while border > 0 && code_points[at] != code_points[border] {
            border = borders[border] as usize;
        }
        if code_points[at] == code_points[border] {
            border += 1;
        }
        borders[at + 1] = border as u32;
    }
    borders
}

fn reachable_positions_of(borders: &[u32], length: usize) -> Vec<u64> {
    let mut reachable = vec![0u64; length + 1];
    for prefix in 1..=length {
        reachable[prefix] = u64::from(prefix < length) + reachable[borders[prefix] as usize];
    }
    reachable
}

#[derive(Clone)]
pub(crate) struct LiteralMatcher {
    code_points: Vec<u32>,
    borders: Vec<u32>,
    reachable: Vec<u64>,
    anchored_start: bool,
    anchored_end: bool,
    prefix: usize,
    alive: bool,
    accepting: bool,
    decided: Option<bool>,
}

impl LiteralMatcher {
    pub(crate) fn new(code_points: Vec<u32>, anchored_start: bool, anchored_end: bool) -> Self {
        let borders = borders_of(&code_points);
        let reachable = reachable_positions_of(&borders, code_points.len());
        LiteralMatcher {
            code_points,
            borders,
            reachable,
            anchored_start,
            anchored_end,
            prefix: 0,
            alive: true,
            accepting: false,
            decided: None,
        }
    }

    pub(crate) fn begin(&mut self) -> bool {
        self.decided = None;
        self.prefix = 0;
        self.alive = !self.code_points.is_empty();
        self.accepting = self.code_points.is_empty();
        if !self.anchored_end && self.accepting {
            return self.decide(true);
        }
        true
    }

    #[inline]
    pub(crate) fn feed(&mut self, code_point: u32, tally: &mut WorkTally<'_>) -> Result<bool> {
        let steps = self.steps();
        if steps == 0 {
            let outcome = !self.anchored_start && self.code_points.is_empty();
            return Ok(self.decide(outcome));
        }
        tally.add(steps)?;
        if self.anchored_start {
            self.advance_anchored(code_point);
        } else {
            self.advance(code_point);
        }
        if !self.anchored_end && self.accepting {
            return Ok(self.decide(true));
        }
        Ok(true)
    }

    pub(crate) fn matched(&self) -> bool {
        self.decided.unwrap_or(self.anchored_end && self.accepting)
    }

    fn steps(&self) -> u64 {
        let length = self.code_points.len();
        if length == 0 {
            return 0;
        }
        if self.anchored_start {
            return u64::from(self.alive && self.prefix < length);
        }
        1 + self.reachable[self.prefix]
    }

    fn advance_anchored(&mut self, code_point: u32) {
        if self.code_points.get(self.prefix) == Some(&code_point) {
            self.prefix += 1;
            self.accepting = self.prefix == self.code_points.len();
            return;
        }
        self.alive = false;
        self.accepting = false;
    }

    fn advance(&mut self, code_point: u32) {
        let length = self.code_points.len();
        let mut prefix = if self.prefix == length {
            self.borders[self.prefix] as usize
        } else {
            self.prefix
        };
        while prefix > 0 && self.code_points[prefix] != code_point {
            prefix = self.borders[prefix] as usize;
        }
        if self.code_points[prefix] == code_point {
            prefix += 1;
        }
        self.prefix = prefix;
        self.accepting = prefix == length;
    }

    fn decide(&mut self, outcome: bool) -> bool {
        self.decided = Some(outcome);
        false
    }
}
