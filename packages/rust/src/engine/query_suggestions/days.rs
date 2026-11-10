use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use jiff::Timestamp;
use jiff::tz::TimeZone;

use super::constants::DAY_MS;
use super::counts_file::{OpenedCountsFile, encode_counts_file, open_counts_file};
use super::day_counts::{CountOutcome, DayCounts, DayLimits};
use super::day_groups::{HeldGroups, history_groups, note_groups};
use super::history::{HistoryRead, day_file_key, read_history_file};
use super::known::suggestion_state_of;
use super::scramble::Scrambler;
use super::setting::ResolvedSetting;
use super::types::QuerySuggestionsWarningReason;
use super::warnings::warn;
use super::writer::marked_suggestion_indexes;
use crate::durability::checkpoint_store::CheckpointStore;
use crate::durability::platform::now_ms;
use crate::engine::EngineInner;
use crate::error::Result;

/// Returns the UTC day of `instant_ms` as `YYYY-MM-DD`.
pub(crate) fn day_of(instant_ms: i64) -> String {
    Timestamp::from_millisecond(instant_ms)
        .map(|timestamp| TimeZone::UTC.to_datetime(timestamp).date().to_string())
        .unwrap_or_default()
}

/// Returns the first day that a setting with `retention_days` keeps at `now_ms`.
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

/// What the engine needs to read and write the counts of one index.
pub(crate) struct DayContext<'a> {
    pub(crate) engine: &'a EngineInner,
    pub(crate) files: &'a dyn CheckpointStore,
    pub(crate) scrambler: &'a Scrambler,
}

/// One search to count.
pub(crate) struct CountRequest<'a> {
    pub(crate) group: &'a str,
    pub(crate) phrase: &'a str,
    pub(crate) person: &'a str,
}

/// What counting one search did, where the feature stayed on.
pub(crate) enum Counted {
    Outcome(CountOutcome),
    Banned,
    Off,
}

#[derive(Default)]
struct IndexDays {
    current: Option<DayCounts>,
    unsaved: Vec<DayCounts>,
    warned: HashSet<(String, &'static str)>,
    groups: Option<HeldGroups>,
}

/// The counts that the engine holds in memory for each index, which one lock for each index orders.
#[derive(Default)]
pub(crate) struct DayStore {
    indexes: Mutex<HashMap<String, Arc<Mutex<IndexDays>>>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl DayStore {
    fn days_of(&self, index_name: &str) -> Arc<Mutex<IndexDays>> {
        Arc::clone(
            locked(&self.indexes)
                .entry(index_name.to_string())
                .or_default(),
        )
    }

    fn held(&self, index_name: &str) -> Option<Arc<Mutex<IndexDays>>> {
        locked(&self.indexes).get(index_name).cloned()
    }

    /// Returns the name of every index whose counts the store holds.
    pub(crate) fn indexes(&self) -> Vec<String> {
        locked(&self.indexes).keys().cloned().collect()
    }

    /// Reports whether the store holds counts of `index_name` that no save wrote yet.
    pub(crate) fn has_unsaved(&self, index_name: &str) -> bool {
        self.held(index_name).is_some_and(|days| {
            let days = locked(&days);
            !days.unsaved.is_empty() || days.current.as_ref().is_some_and(DayCounts::is_changed)
        })
    }

    /// Counts one search of `request`, where the index still has the feature on and no ban holds the phrase.
    pub(crate) fn count(
        &self,
        context: &DayContext<'_>,
        index_name: &str,
        setting: &ResolvedSetting,
        now_ms: i64,
        request: &CountRequest<'_>,
    ) -> Result<Counted> {
        let held = self.days_of(index_name);
        let mut days = locked(&held);
        let Some(state) = suggestion_state_of(context.engine, index_name) else {
            return Ok(Counted::Off);
        };
        if !state.enabled() {
            return Ok(Counted::Off);
        }
        if state.banned.iter().any(|banned| banned == request.phrase) {
            return Ok(Counted::Banned);
        }
        current_day(context, index_name, &mut days, setting, now_ms)?;
        let cutoff = cutoff_day(now_ms, setting.retention_days);
        let allowed = days
            .current
            .as_ref()
            .is_some_and(|counts| counts.has_group(request.group))
            || group_allowed(
                context,
                index_name,
                &mut days,
                &cutoff,
                request.group,
                setting.max_groups,
            );
        let scrambled = context.scrambler.scramble(request.person);
        let Some(counts) = days.current.as_mut() else {
            return Ok(Counted::Off);
        };
        let outcome = counts.count(request.group, request.phrase, &scrambled, allowed);
        let reason = match outcome {
            CountOutcome::PhraseLimit => {
                Some(("phrase-limit", QuerySuggestionsWarningReason::PhraseLimit))
            }
            CountOutcome::PeopleLimit => {
                Some(("people-limit", QuerySuggestionsWarningReason::PeopleLimit))
            }
            _ => None,
        };
        if let Some((mark, reason)) = reason {
            let day = counts.day.clone();
            if days.warned.insert((day, mark)) {
                warn(context.engine, index_name, reason, None, None);
            }
        }
        Ok(Counted::Outcome(outcome))
    }

    /// Writes every changed day of `index_name`.
    pub(crate) fn save(&self, context: &DayContext<'_>, index_name: &str) {
        if let Some(held) = self.held(index_name) {
            save_now(context, index_name, &mut locked(&held));
        }
    }

    /// Writes the counts of `index_name`, then lets go of a day before `today` that the save wrote.
    pub(crate) fn retire(&self, context: &DayContext<'_>, index_name: &str, today: &str) {
        let Some(held) = self.held(index_name) else {
            return;
        };
        let mut days = locked(&held);
        save_now(context, index_name, &mut days);
        let finished = days
            .current
            .as_ref()
            .is_some_and(|counts| counts.day.as_str() < today && !counts.is_changed());
        if finished && let Some(counts) = days.current.take() {
            note_groups(&mut days.groups, &counts);
        }
    }

    /// Forgets which groups the history of `index_name` names, so that the next count reads them again.
    pub(crate) fn forget_history_groups(&self, index_name: &str) {
        if let Some(held) = self.held(index_name) {
            locked(&held).groups = None;
        }
    }

    /// Drops every count of `index_name` that the store holds, saved or not.
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
    let mut known: HashSet<String> = HashSet::new();
    if let Some(counts) = &days.current {
        known.extend(counts.groups().iter().map(|table| table.name.clone()));
    }
    for unsaved in &days.unsaved {
        known.extend(unsaved.groups().iter().map(|table| table.name.clone()));
    }
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
    let bytes = match read_history_file(context.files, &key)? {
        HistoryRead::Bytes(bytes) => bytes,
        HistoryRead::Missing => return Ok(counts),
        HistoryRead::TooLong => {
            warn(
                context.engine,
                index_name,
                QuerySuggestionsWarningReason::DamagedFile,
                Some(key),
                None,
            );
            return Ok(counts);
        }
    };
    let opened = match open_counts_file(&bytes, Some(&counts.day), context.scrambler.fingerprint())
    {
        OpenedCountsFile::Counts(opened) => opened,
        OpenedCountsFile::OtherKey => {
            warn(
                context.engine,
                index_name,
                QuerySuggestionsWarningReason::OtherKey,
                Some(key),
                None,
            );
            return Ok(counts);
        }
        OpenedCountsFile::Damaged(_) => {
            warn(
                context.engine,
                index_name,
                QuerySuggestionsWarningReason::DamagedFile,
                Some(key),
                None,
            );
            return Ok(counts);
        }
    };
    opened.visit(&mut |visited| {
        let count = u32::try_from(visited.count).unwrap_or(u32::MAX);
        counts.restore_phrase(visited.group, visited.phrase, count, visited.people);
        Ok(())
    })?;
    Ok(counts)
}

fn save_now(context: &DayContext<'_>, index_name: &str, days: &mut IndexDays) {
    let mut still_unsaved = Vec::new();
    for mut counts in std::mem::take(&mut days.unsaved) {
        write_day(context, index_name, &mut counts);
        if counts.is_changed() {
            still_unsaved.push(counts);
        }
    }
    days.unsaved = still_unsaved;
    if let Some(counts) = days.current.as_mut() {
        write_day(context, index_name, counts);
    }
}

fn write_day(context: &DayContext<'_>, index_name: &str, counts: &mut DayCounts) {
    if !counts.is_changed() {
        return;
    }
    let written = encode_counts_file(counts, context.scrambler.fingerprint(), now_ms(), None)
        .and_then(|bytes| {
            context
                .files
                .write_commit(&day_file_key(index_name, &counts.day), &bytes)
        });
    match written {
        Ok(()) => counts.mark_saved(),
        Err(error) => warn(
            context.engine,
            index_name,
            QuerySuggestionsWarningReason::SaveFailed,
            None,
            Some(error.message().to_string()),
        ),
    }
}
