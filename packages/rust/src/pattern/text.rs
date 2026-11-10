use super::constants::PATTERN_RUN_CODE_POINTS;
use super::fold::append_fold;

pub(crate) type Run = [u32; PATTERN_RUN_CODE_POINTS];

pub(crate) fn append_text_code_points(text: &str, case_fold: bool, out: &mut Vec<u32>) {
    for character in text.chars() {
        if case_fold {
            append_fold(character as u32, out);
        } else {
            out.push(character as u32);
        }
    }
}

pub(crate) fn folded_code_points(text: &str) -> Vec<u32> {
    let mut folded = Vec::with_capacity(text.len());
    append_text_code_points(text, true, &mut folded);
    folded
}

pub(crate) fn runs_of(folded: &[u32]) -> impl Iterator<Item = Run> + '_ {
    folded
        .windows(PATTERN_RUN_CODE_POINTS)
        .map(|window| [window[0], window[1], window[2]])
}

pub(crate) fn run_at(runs: &[u32], index: usize) -> Option<Run> {
    let at = index * PATTERN_RUN_CODE_POINTS;
    let run = runs.get(at..at + PATTERN_RUN_CODE_POINTS)?;
    Some([run[0], run[1], run[2]])
}

pub(crate) fn find_run(runs: &[u32], run: Run) -> Option<usize> {
    let mut low = 0;
    let mut high = runs.len() / PATTERN_RUN_CODE_POINTS;
    while low < high {
        let middle = (low + high) / 2;
        let candidate = run_at(runs, middle)?;
        match candidate.cmp(&run) {
            std::cmp::Ordering::Equal => return Some(middle),
            std::cmp::Ordering::Less => low = middle + 1,
            std::cmp::Ordering::Greater => high = middle,
        }
    }
    None
}
