/// Returns the first `prefix_length` characters of `term`, which every typo match of `term` must start with.
pub(crate) fn fuzzy_prefix(term: &str, prefix_length: u32) -> &str {
    match term.char_indices().nth(prefix_length as usize) {
        Some((end, _)) => &term[..end],
        None => term,
    }
}

/// Reports whether an index term stands for `term` under a typo tolerance: it equals `term`, or it starts with
/// the first `prefix_length` characters of `term` and lies within `tolerance` edits of it.
pub(crate) fn fuzzy_term_matches(
    term: &str,
    candidate: &str,
    tolerance: u32,
    prefix_length: u32,
) -> bool {
    if term == candidate {
        return true;
    }
    if tolerance == 0 || !candidate.starts_with(fuzzy_prefix(term, prefix_length)) {
        return false;
    }
    within_edits(term, candidate, tolerance)
}

/// Reports whether `candidate` lies within `tolerance` edits of `term`, counting each character as one unit.
pub(crate) fn within_edits(term: &str, candidate: &str, tolerance: u32) -> bool {
    if term == candidate {
        return true;
    }
    let left: Vec<char> = term.chars().collect();
    let right: Vec<char> = candidate.chars().collect();
    banded_distance(&left, &right, tolerance as usize) <= tolerance as usize
}

fn banded_distance(left: &[char], right: &[char], tolerance: usize) -> usize {
    let rows = left.len();
    let columns = right.len();
    let beyond = tolerance + 1;
    if rows.abs_diff(columns) > tolerance {
        return beyond;
    }
    let mut previous = vec![beyond; columns + 1];
    let mut current = vec![beyond; columns + 1];
    for (column, cell) in previous
        .iter_mut()
        .enumerate()
        .take(columns.min(tolerance) + 1)
    {
        *cell = column;
    }
    for row in 1..=rows {
        let low = row.saturating_sub(tolerance).max(1);
        let high = columns.min(row + tolerance);
        current[low - 1] = if low == 1 { row } else { beyond };
        let mut row_minimum = current[low - 1];
        let character = left[row - 1];
        for column in low..=high {
            let substitution = previous[column - 1] + usize::from(character != right[column - 1]);
            let cell = (previous[column] + 1)
                .min(current[column - 1] + 1)
                .min(substitution)
                .min(beyond);
            current[column] = cell;
            row_minimum = row_minimum.min(cell);
        }
        if row_minimum > tolerance {
            return beyond;
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[columns]
}
