use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use jiff::Timestamp;
use jiff::tz::TimeZone;

use super::constants::DAY_MS;
use super::counts_file::{OpenedCountsFile, encode_counts_file, open_counts_file};
use super::day_counts::{DayCounts, DayLimits};
use super::history_files::{HistoryRead, day_file_key, read_history_file};
use super::history_groups::{HeldGroups, history_groups, note_groups};
use super::host::{locked, suggestion_state_of, warn, warn_of_failure};
use super::scramble::Scrambler;
use super::setting::ResolvedSetting;
use super::suggestions_writer::marked_suggestion_indexes;
use super::types::{QuerySuggestionsWarningReason, RecordQueryOutcome};
use crate::durability::checkpoint_store::CheckpointStore;
use crate::durability::platform::now_ms;
use crate::engine::EngineInner;
use crate::engine::event_hold::hold_events;
use crate::error::Result;

pub(crate) fn day_of(instant_ms: i64) -> String {
    Timestamp::from_millisecond(instant_ms)
        .map(|timestamp| TimeZone::UTC.to_datetime(timestamp).date().to_string())
        .unwrap_or_default()
}

pub(crate) fn cutoff_day(now_ms: i64, retention_days: u32) -> String {
    day_of(now_ms.saturating_sub(i64::from(retention_days).saturating_mul(DAY_MS)))
}

fn limits_of(setting: &ResolvedSetting) -> DayLimits {
    DayLimits {
        min_people: setting.min_people,
        max_phrases_per_day: setting.max_phrases_per_day,
        max_phrases_per_person: setting.max_phrases_per_person,
        max_people_per_day: setting.max_people_per_day,
        max_groups: setting.max_groups,
    }
}

pub(crate) struct DayContext<'a> {
    pub(crate) engine: &'a EngineInner,
    pub(crate) files: &'a dyn CheckpointStore,
    pub(crate) scrambler: &'a Scrambler,
}

pub(crate) struct CountRequest<'a> {
    pub(crate) group: &'a str,
    pub(crate) phrase: &'a str,
    pub(crate) person: &'a str,
}

#[derive(Default)]
struct IndexDays {
    current: Option<DayCounts>,
    unsaved: Vec<DayCounts>,
    warned: HashSet<(String, QuerySuggestionsWarningReason)>,
    groups: Option<HeldGroups>,
}

#[derive(Default)]
pub(crate) struct DayStore {
    indexes: Mutex<HashMap<String, Arc<Mutex<IndexDays>>>>,
}

impl DayStore {
    fn held(&self, index_name: &str) -> Option<Arc<Mutex<IndexDays>>> {
        locked(&self.indexes).get(index_name).cloned()
    }

    pub(crate) fn indexes(&self) -> Vec<String> {
        locked(&self.indexes).keys().cloned().collect()
    }

    pub(crate) fn has_unsaved(&self, index_name: &str) -> bool {
        self.held(index_name).is_some_and(|days| {
            let days = locked(&days);
            !days.unsaved.is_empty() || days.current.as_ref().is_some_and(DayCounts::is_changed)
        })
    }

    pub(crate) fn count(
        &self,
        context: &DayContext<'_>,
        index_name: &str,
        setting: &ResolvedSetting,
        now_ms: i64,
        request: &CountRequest<'_>,
    ) -> Result<Option<RecordQueryOutcome>> {
        let held = Arc::clone(
            locked(&self.indexes)
                .entry(index_name.to_string())
                .or_default(),
        );
        let _events = hold_events();
        let mut days = locked(&held);
        let Some(state) =
            suggestion_state_of(context.engine, index_name).filter(|state| state.enabled())
        else {
            return Ok(None);
        };
        if state.banned.iter().any(|banned| banned == request.phrase) {
            return Ok(Some(RecordQueryOutcome::Banned));
        }
        current_day(context, index_name, &mut days, setting, now_ms)?;
        let cutoff = cutoff_day(now_ms, setting.retention_days);
        let allowed = group_allowed(
            context,
            index_name,
            &mut days,
            &cutoff,
            request.group,
            setting.max_groups,
        );
        let scrambled = context.scrambler.scramble(request.person);
        let Some(counts) = days.current.as_mut() else {
            return Ok(None);
        };
        let outcome = counts.count(request.group, request.phrase, &scrambled, allowed);
        let day = counts.day.clone();
        let reason = match outcome {
            RecordQueryOutcome::PhraseLimit => QuerySuggestionsWarningReason::PhraseLimit,
            RecordQueryOutcome::PeopleLimit => QuerySuggestionsWarningReason::PeopleLimit,
            _ => return Ok(Some(outcome)),
        };
        if days.warned.insert((day, reason)) {
            warn(context.engine, index_name, reason, None, None);
        }
        Ok(Some(outcome))
    }

    pub(crate) fn save(&self, context: &DayContext<'_>, index_name: &str) {
        if let Some(held) = self.held(index_name) {
            let _events = hold_events();
            save_now(context, index_name, &mut locked(&held));
        }
    }

    pub(crate) fn retire(&self, context: &DayContext<'_>, index_name: &str, today: &str) {
        let Some(held) = self.held(index_name) else {
            return;
        };
        let _events = hold_events();
        let mut days = locked(&held);
        save_now(context, index_name, &mut days);
        if let Some(counts) = days
            .current
            .take_if(|counts| counts.day.as_str() < today && !counts.is_changed())
        {
            note_groups(&mut days.groups, &counts);
        }
    }

    pub(crate) fn forget_history_groups(&self, index_name: &str) {
        if let Some(held) = self.held(index_name) {
            locked(&held).groups = None;
        }
    }

    pub(crate) fn discard(&self, index_name: &str) {
        let held = locked(&self.indexes).remove(index_name);
        if let Some(held) = held {
            *locked(&held) = IndexDays::default();
        }
    }
}

fn group_allowed(
    context: &DayContext<'_>,
    index_name: &str,
    days: &mut IndexDays,
    cutoff: &str,
    group: &str,
    max_groups: u32,
) -> bool {
    if days
        .current
        .as_ref()
        .is_some_and(|counts| counts.has_group(group))
    {
        return true;
    }
    let mut known: HashSet<String> = days
        .current
        .iter()
        .chain(&days.unsaved)
        .flat_map(DayCounts::groups)
        .map(|table| table.name.clone())
        .collect();
    known.extend(history_groups(
        context,
        index_name,
        &mut days.groups,
        cutoff,
    ));
    known.extend(marked_suggestion_indexes(context.engine, index_name).into_keys());
    known.contains(group) || known.len() < max_groups as usize
}

fn current_day(
    context: &DayContext<'_>,
    index_name: &str,
    days: &mut IndexDays,
    setting: &ResolvedSetting,
    now: i64,
) -> Result<()> {
    let day = day_of(now);
    let limits = limits_of(setting);
    if days
        .current
        .as_ref()
        .is_some_and(|counts| counts.day == day && counts.limits == limits)
    {
        return Ok(());
    }
    if days.current.is_some() {
        save_now(context, index_name, days);
        if let Some(counts) = days.current.take() {
            if counts.is_changed() && counts.day == day {
                days.current = Some(counts);
                return Ok(());
            }
            note_groups(&mut days.groups, &counts);
            if counts.is_changed() {
                days.unsaved.push(counts);
            }
        }
    }
    days.current = Some(load_day(context, index_name, day, limits)?);
    Ok(())
}

fn load_day(
    context: &DayContext<'_>,
    index_name: &str,
    day: String,
    limits: DayLimits,
) -> Result<DayCounts> {
    let mut counts = DayCounts::new(day, limits);
    let key = day_file_key(index_name, &counts.day);
    let unreadable = match read_history_file(context.files, &key)? {
        HistoryRead::Missing => return Ok(counts),
        HistoryRead::TooLong => QuerySuggestionsWarningReason::DamagedFile,
        HistoryRead::Bytes(bytes) => {
            match open_counts_file(&bytes, Some(&counts.day), context.scrambler.fingerprint()) {
                OpenedCountsFile::Counts(opened) => {
                    opened.visit(&mut |visited| {
                        let count = u32::try_from(visited.count).unwrap_or(u32::MAX);
                        counts.restore_phrase(visited.group, visited.phrase, count, visited.people);
                        Ok(())
                    })?;
                    return Ok(counts);
                }
                OpenedCountsFile::OtherKey => QuerySuggestionsWarningReason::OtherKey,
                OpenedCountsFile::Damaged(_) => QuerySuggestionsWarningReason::DamagedFile,
            }
        }
    };
    warn(context.engine, index_name, unreadable, Some(key), None);
    Ok(counts)
}

fn save_now(context: &DayContext<'_>, index_name: &str, days: &mut IndexDays) {
    days.unsaved.retain_mut(|counts| {
        write_day(context, index_name, counts);
        counts.is_changed()
    });
    if let Some(counts) = days.current.as_mut() {
        write_day(context, index_name, counts);
    }
}

fn write_day(context: &DayContext<'_>, index_name: &str, counts: &mut DayCounts) {
    if !counts.is_changed() {
        return;
    }
    let key = day_file_key(index_name, &counts.day);
    let written = encode_counts_file(counts, context.scrambler.fingerprint(), now_ms())
        .and_then(|bytes| context.files.write_commit(&key, &bytes));
    match written {
        Ok(()) => counts.mark_saved(),
        Err(error) => warn_of_failure(
            context.engine,
            index_name,
            QuerySuggestionsWarningReason::SaveFailed,
            &error,
        ),
    }
}
