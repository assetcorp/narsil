use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use super::build::{due_phrases_of, groups_to_write, meets_min_results, merge_history};
use super::host::wall_ms;
use super::merge::compare_utf16;
use super::types::{QuerySuggestionPreviewEntry, QuerySuggestionsPreview};
use crate::engine::Narsil;
use crate::error::Result;

fn preview_order(
    left: &QuerySuggestionPreviewEntry,
    right: &QuerySuggestionPreviewEntry,
) -> Ordering {
    right
        .count
        .cmp(&left.count)
        .then_with(|| compare_utf16(&left.group, &right.group))
        .then_with(|| compare_utf16(&left.query, &right.query))
}

pub(crate) fn preview_build(
    narsil: &Narsil,
    index_name: &str,
    max: usize,
) -> Result<QuerySuggestionsPreview> {
    let engine = &narsil.inner;
    let setting = engine.suggestions.enabled_setting(engine, index_name)?;
    engine.suggestions.require_scrambler()?;
    let merged = merge_history(narsil, index_name, &setting, wall_ms())?;
    let (groups, _) = groups_to_write(narsil, index_name, &setting, &merged.result);
    let state = engine.open_index(index_name)?.suggestion_state();
    let banned: HashSet<&String> = state.banned.iter().collect();
    let mut candidates = Vec::new();
    for group in groups {
        for due in due_phrases_of(&merged.result, &group) {
            if !banned.contains(&due.phrase) {
                candidates.push(QuerySuggestionPreviewEntry {
                    group: group.clone(),
                    query: due.phrase.clone(),
                    count: due.count,
                });
            }
        }
    }
    candidates.sort_by(preview_order);
    let mut checked: HashMap<&str, bool> = HashMap::new();
    let mut entries = Vec::new();
    let mut next = 0;
    while entries.len() < max {
        let Some(candidate) = candidates.get(next) else {
            break;
        };
        next += 1;
        let passes = match checked.get(candidate.query.as_str()) {
            Some(passes) => *passes,
            None => {
                let passes = meets_min_results(narsil, index_name, &setting, &candidate.query)?;
                checked.insert(&candidate.query, passes);
                passes
            }
        };
        if passes {
            entries.push(candidate.clone());
        }
    }
    Ok(QuerySuggestionsPreview {
        entries,
        truncated: next < candidates.len(),
    })
}
