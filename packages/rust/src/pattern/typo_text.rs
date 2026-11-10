use super::constants::PATTERN_RUN_CODE_POINTS;
use super::text::append_folded_code_point;
use crate::error::Result;

pub(crate) struct TypoText {
    pub(crate) folded: Vec<u32>,
    pub(crate) longest_fold: usize,
}

pub(crate) fn fold_typo_text(text: &str) -> Result<TypoText> {
    let mut folded = Vec::with_capacity(text.len());
    let mut longest_fold = 0;
    for character in text.chars() {
        let before = folded.len();
        append_folded_code_point(u32::from(character), &mut folded)?;
        longest_fold = longest_fold.max(folded.len() - before);
    }
    Ok(TypoText {
        folded,
        longest_fold,
    })
}

fn keep_distinct_run(runs: &mut Vec<u32>, folded: &[u32], at: usize) {
    let Some(run) = folded.get(at..at + PATTERN_RUN_CODE_POINTS) else {
        return;
    };
    if !runs
        .chunks_exact(PATTERN_RUN_CODE_POINTS)
        .any(|kept| kept == run)
    {
        runs.extend_from_slice(run);
    }
}

fn rounded_quotient(numerator: usize, denominator: usize) -> usize {
    (2 * numerator + denominator) / (2 * denominator)
}

pub(crate) fn distinct_typo_run_count(text: &TypoText, limit: usize) -> usize {
    let folded = &text.folded;
    let positions = (folded.len() + 1).saturating_sub(PATTERN_RUN_CODE_POINTS);
    let wanted = limit * PATTERN_RUN_CODE_POINTS;
    let mut runs = Vec::with_capacity(wanted);
    if positions > limit && limit > 1 {
        for pick in 0..limit {
            keep_distinct_run(
                &mut runs,
                folded,
                rounded_quotient(pick * (positions - 1), limit - 1),
            );
        }
    }
    let mut at = 0;
    while at < positions && runs.len() < wanted {
        keep_distinct_run(&mut runs, folded, at);
        at += 1;
    }
    runs.len() / PATTERN_RUN_CODE_POINTS
}

pub(crate) fn typo_runs_needed(tolerance: u32, longest_fold: usize) -> usize {
    tolerance as usize * (2 + longest_fold) + 1
}
