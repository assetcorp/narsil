use super::constants::{MAX_PATTERN_TOLERANCE, PATTERN_RUN_CODE_POINTS, SHORTLIST_RUN_LOOKUPS};
use super::fold::append_fold;

pub(crate) struct TypoText {
    pub(crate) code_points: usize,
    pub(crate) folded: Vec<u32>,
    pub(crate) longest_fold: usize,
}

pub(crate) fn fold_typo_text(text: &str, units: &mut u64) -> TypoText {
    let mut folded = Vec::with_capacity(text.len());
    let mut code_points = 0;
    let mut longest_fold = 0;
    for character in text.chars() {
        *units += 1;
        let before = folded.len();
        append_fold(character as u32, &mut folded);
        code_points += 1;
        longest_fold = longest_fold.max(folded.len() - before);
    }
    TypoText {
        code_points,
        folded,
        longest_fold,
    }
}

fn holds_run(runs: &[u32], run: &[u32]) -> bool {
    runs.chunks_exact(PATTERN_RUN_CODE_POINTS)
        .any(|kept| kept == run)
}

fn keep_distinct_run(runs: &mut Vec<u32>, folded: &[u32], at: usize, units: &mut u64) {
    *units += 1;
    let Some(run) = folded.get(at..at + PATTERN_RUN_CODE_POINTS) else {
        return;
    };
    if !holds_run(runs, run) {
        runs.extend_from_slice(run);
    }
}

fn rounded_quotient(numerator: usize, denominator: usize) -> usize {
    (2 * numerator + denominator) / (2 * denominator)
}

pub(crate) fn distinct_typo_runs(text: &TypoText, limit: usize, units: &mut u64) -> Vec<u32> {
    let folded = &text.folded;
    let positions = (folded.len() + 1).saturating_sub(PATTERN_RUN_CODE_POINTS);
    let wanted = limit * PATTERN_RUN_CODE_POINTS;
    let mut runs = Vec::with_capacity(wanted);
    if positions > limit && limit > 1 {
        for pick in 0..limit {
            let at = rounded_quotient(pick * (positions - 1), limit - 1);
            keep_distinct_run(&mut runs, folded, at, units);
        }
    }
    let mut at = 0;
    while at < positions && runs.len() < wanted {
        keep_distinct_run(&mut runs, folded, at, units);
        at += 1;
    }
    runs
}

pub(crate) fn typo_runs_needed(tolerance: u32, longest_fold: usize) -> usize {
    tolerance as usize * (2 + longest_fold) + 1
}

pub(crate) fn typo_run_limit(longest_fold: usize) -> usize {
    typo_runs_needed(MAX_PATTERN_TOLERANCE, longest_fold).max(SHORTLIST_RUN_LOOKUPS)
}

pub(crate) fn resolved_typo_tolerance(
    tolerance: Option<u32>,
    longest_fold: usize,
    distinct_runs: usize,
) -> u32 {
    if let Some(tolerance) = tolerance {
        return tolerance;
    }
    (1..=MAX_PATTERN_TOLERANCE)
        .rev()
        .find(|&candidate| distinct_runs >= typo_runs_needed(candidate, longest_fold))
        .unwrap_or(0)
}

pub(crate) struct BandedRows {
    previous: Vec<u32>,
    current: Vec<u32>,
}

impl BandedRows {
    pub(crate) fn new() -> BandedRows {
        BandedRows {
            previous: Vec::new(),
            current: Vec::new(),
        }
    }

    pub(crate) fn within(&mut self, left: &[u32], right: &[u32], tolerance: u32) -> (bool, u64) {
        let rows = left.len();
        let columns = right.len();
        let band = tolerance as usize;
        let beyond = tolerance + 1;
        if rows.abs_diff(columns) > band {
            return (false, 0);
        }
        self.previous.clear();
        self.previous.resize(columns + 1, beyond);
        self.current.clear();
        self.current.resize(columns + 1, beyond);
        for column in 0..=columns.min(band) {
            self.previous[column] = column as u32;
        }
        let mut cells = 0u64;
        for row in 1..=rows {
            let low = row.saturating_sub(band).max(1);
            let high = columns.min(row + band);
            self.current[low - 1] = if low == 1 { row as u32 } else { beyond };
            let mut row_minimum = self.current[low - 1];
            let code_point = left[row - 1];
            if high >= low {
                cells += (high - low + 1) as u64;
            }
            for column in low..=high {
                let substitution =
                    self.previous[column - 1] + u32::from(code_point != right[column - 1]);
                let cell = (self.previous[column] + 1)
                    .min(self.current[column - 1] + 1)
                    .min(substitution)
                    .min(beyond);
                self.current[column] = cell;
                row_minimum = row_minimum.min(cell);
            }
            if row_minimum > tolerance {
                return (false, cells);
            }
            std::mem::swap(&mut self.previous, &mut self.current);
        }
        (self.previous[columns] <= tolerance, cells)
    }
}
