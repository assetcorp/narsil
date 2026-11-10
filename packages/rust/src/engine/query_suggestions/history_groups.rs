use std::collections::HashMap;

use super::counts_file::{OpenedCountsFile, open_counts_file};
use super::day_counts::DayCounts;
use super::day_store::DayContext;
use super::history_files::{HistoryRead, history_files_of, read_history_file};

pub(crate) struct HeldGroups {
    cutoff: String,
    newest_day: HashMap<String, String>,
}

fn note_group(newest_day: &mut HashMap<String, String>, group: &str, day: &str) {
    match newest_day.get_mut(group) {
        Some(newest) if newest.as_str() < day => *newest = day.to_string(),
        Some(_) => {}
        None => {
            newest_day.insert(group.to_string(), day.to_string());
        }
    }
}

pub(crate) fn note_groups(held: &mut Option<HeldGroups>, counts: &DayCounts) {
    if let Some(held) = held.as_mut().filter(|held| counts.day >= held.cutoff) {
        for table in counts.groups() {
            note_group(&mut held.newest_day, &table.name, &counts.day);
        }
    }
}

pub(crate) fn history_groups(
    context: &DayContext<'_>,
    index_name: &str,
    held: &mut Option<HeldGroups>,
    cutoff: &str,
) -> Vec<String> {
    let groups = match held.take() {
        Some(mut groups) if groups.cutoff.as_str() <= cutoff => {
            if groups.cutoff.as_str() < cutoff {
                groups.newest_day.retain(|_, day| day.as_str() >= cutoff);
                groups.cutoff = cutoff.to_string();
            }
            groups
        }
        _ => HeldGroups {
            cutoff: cutoff.to_string(),
            newest_day: load_history_groups(context, index_name, cutoff),
        },
    };
    let names = groups.newest_day.keys().cloned().collect();
    *held = Some(groups);
    names
}

fn load_history_groups(
    context: &DayContext<'_>,
    index_name: &str,
    cutoff: &str,
) -> HashMap<String, String> {
    let mut newest_day: HashMap<String, String> = HashMap::new();
    let Ok(files) = history_files_of(context.files, index_name) else {
        return newest_day;
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
            note_group(&mut newest_day, &group, &file.day);
        }
    }
    newest_day
}
