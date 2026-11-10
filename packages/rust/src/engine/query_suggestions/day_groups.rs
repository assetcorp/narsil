use std::collections::HashMap;

use super::counts_file::{OpenedCountsFile, open_counts_file};
use super::day_counts::DayCounts;
use super::days::DayContext;
use super::history::{HistoryRead, history_files_of, read_history_file};

/// The groups that the history files of one index hold, each with the newest day that holds it, from `cutoff`
/// onwards.
pub(crate) struct HeldGroups {
    cutoff: String,
    newest: HashMap<String, String>,
}

/// Adds the groups of a day that the engine lets go of to the groups that the history holds.
pub(crate) fn note_groups(held: &mut Option<HeldGroups>, counts: &DayCounts) {
    let Some(held) = held.as_mut() else {
        return;
    };
    if counts.day < held.cutoff {
        return;
    }
    for table in counts.groups() {
        let newest = held
            .newest
            .entry(table.name.clone())
            .or_insert_with(|| counts.day.clone());
        if *newest < counts.day {
            newest.clone_from(&counts.day);
        }
    }
}

/// Returns the groups that the history of `index_name` holds from `cutoff` onwards, reading the history files
/// once and keeping their groups until the cutoff moves back.
pub(crate) fn history_groups(
    context: &DayContext<'_>,
    index_name: &str,
    held: &mut Option<HeldGroups>,
    cutoff: &str,
) -> Vec<String> {
    if let Some(groups) = held.as_mut()
        && groups.cutoff.as_str() <= cutoff
    {
        if groups.cutoff.as_str() < cutoff {
            groups.newest.retain(|_, day| day.as_str() >= cutoff);
            groups.cutoff = cutoff.to_string();
        }
        return groups.newest.keys().cloned().collect();
    }
    let newest = load_history_groups(context, index_name, cutoff);
    let names = newest.keys().cloned().collect();
    *held = Some(HeldGroups {
        cutoff: cutoff.to_string(),
        newest,
    });
    names
}

fn load_history_groups(
    context: &DayContext<'_>,
    index_name: &str,
    cutoff: &str,
) -> HashMap<String, String> {
    let mut newest: HashMap<String, String> = HashMap::new();
    let Ok(files) = history_files_of(context.files, index_name) else {
        return newest;
    };
    for file in files.iter().filter(|file| file.day.as_str() >= cutoff) {
        let Ok(HistoryRead::Bytes(bytes)) = read_history_file(context.files, &file.key) else {
            continue;
        };
        let OpenedCountsFile::Counts(opened) =
            open_counts_file(&bytes, Some(&file.day), context.scrambler.fingerprint())
        else {
            continue;
        };
        for group in opened.group_names().unwrap_or_default() {
            let day = newest.entry(group).or_insert_with(|| file.day.clone());
            if *day < file.day {
                day.clone_from(&file.day);
            }
        }
    }
    newest
}
