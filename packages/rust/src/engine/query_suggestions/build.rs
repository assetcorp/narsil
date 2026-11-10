use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use super::build_record::{BuildRecord, MergedSource, sources_digest_of};
use super::constants::{MS_PER_SECOND, SOURCES_DIGEST_BYTES};
use super::days::cutoff_day;
use super::history::{HistoryRead, history_files_of, read_history_file};
use super::known::suggestion_state_of;
use super::merge::{FileOutcome, MergeResult, MergeSettings, Merger};
use super::setting::ResolvedSetting;
use super::types::{QuerySuggestionsBuildStatus, QuerySuggestionsWarningReason};
use super::warnings::warn;
use super::writer::{
    UndoStep, ensure_suggestions_index, marked_suggestion_indexes, undo_writes, write_group,
};
use crate::engine::Narsil;
use crate::engine::query::params::{QueryParams, TermMatch};
use crate::error::{ErrorCode, NarsilError, Result};

/// The history that a build merged: the due phrases, the files that it read, and the oldest day among them.
pub(crate) struct MergedHistory {
    pub(crate) result: MergeResult,
    pub(crate) sources: Vec<MergedSource>,
    pub(crate) oldest_day: Option<String>,
}

/// What a build did, which its record keeps.
pub(crate) struct BuildOutcome {
    pub(crate) status: QuerySuggestionsBuildStatus,
    pub(crate) published: u64,
    pub(crate) removed: u64,
    pub(crate) discarded: u64,
    pub(crate) sources_digest: [u8; SOURCES_DIGEST_BYTES],
}

fn shutting_down() -> NarsilError {
    NarsilError::new(ErrorCode::INSTANCE_SHUT_DOWN, "The engine is shutting down")
}

/// Saves the counts of the day, then merges every history file of `index_name` that the setting still keeps.
pub(crate) fn merge_history(
    narsil: &Narsil,
    index_name: &str,
    setting: &ResolvedSetting,
    now_ms: i64,
) -> Result<MergedHistory> {
    let engine = &*narsil.inner;
    let runtime = &engine.suggestions;
    let scrambler = runtime.require_scrambler()?;
    runtime.save_day(engine, index_name);
    let files = runtime.files(engine);
    let cutoff = cutoff_day(now_ms, setting.retention_days);
    let banned: HashSet<String> = engine
        .reach_index(index_name)?
        .suggestion_state()
        .banned
        .iter()
        .cloned()
        .collect();
    let mut merger = Merger::new(MergeSettings {
        min_people: setting.min_people as usize,
        max_merge_phrases: setting.max_merge_phrases as usize,
        max_groups: setting.max_groups as usize,
        marked_groups: marked_suggestion_indexes(engine, index_name)
            .into_keys()
            .collect(),
        banned,
        memory_bytes: setting.merge_memory_bytes,
        fingerprint: *scrambler.fingerprint(),
    });
    let listed = history_files_of(files, index_name).map_err(|error| {
        NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!(
                "The node cannot read its query history folder: {}",
                error.message()
            ),
        )
    })?;
    let mut merged = MergedHistory {
        result: MergeResult::default(),
        sources: Vec::new(),
        oldest_day: None,
    };
    for file in listed.into_iter().filter(|file| file.day >= cutoff) {
        let bytes = match read_history_file(files, &file.key)? {
            HistoryRead::Missing => continue,
            HistoryRead::TooLong => {
                warn(
                    engine,
                    index_name,
                    QuerySuggestionsWarningReason::DamagedFile,
                    Some(file.key),
                    None,
                );
                continue;
            }
            HistoryRead::Bytes(bytes) => bytes,
        };
        match merger.add_file(&bytes, &file.day)? {
            FileOutcome::Merged { day, saved_at } => {
                if merged
                    .oldest_day
                    .as_ref()
                    .is_none_or(|oldest| day < *oldest)
                {
                    merged.oldest_day = Some(day);
                }
                merged.sources.push(MergedSource {
                    node_id: String::new(),
                    key: file.key,
                    saved_at,
                });
            }
            FileOutcome::Damaged => warn(
                engine,
                index_name,
                QuerySuggestionsWarningReason::DamagedFile,
                Some(file.key),
                None,
            ),
            FileOutcome::OtherKey => warn(
                engine,
                index_name,
                QuerySuggestionsWarningReason::OtherKey,
                Some(file.key),
                None,
            ),
        }
    }
    merged.result = merger.result();
    Ok(merged)
}

/// Reports whether a search of every word of `phrase` in the setting's fields finds at least `minResults`
/// documents, then waits so that the checks keep to `resultChecksPerSecond`.
pub(crate) fn meets_min_results(
    narsil: &Narsil,
    index_name: &str,
    setting: &ResolvedSetting,
    phrase: &str,
) -> Result<bool> {
    let runtime = &narsil.inner.suggestions;
    if runtime.is_stopping() {
        return Err(shutting_down());
    }
    let checked = narsil.preflight(
        index_name,
        &QueryParams {
            term: Some(phrase.to_string()),
            fields: Some(setting.fields.clone()),
            term_match: Some(TermMatch::All),
            ..QueryParams::default()
        },
    )?;
    let pause =
        Duration::from_millis(MS_PER_SECOND / u64::from(setting.result_checks_per_second.max(1)));
    if runtime.pause(pause) {
        return Err(shutting_down());
    }
    Ok(checked.count >= u64::from(setting.min_results))
}

/// Returns the groups that a build writes, the groups that hold a suggestions index first, and the number of
/// phrases of the groups that `maxGroups` leaves out.
pub(crate) fn groups_to_write(
    narsil: &Narsil,
    index_name: &str,
    setting: &ResolvedSetting,
    result: &MergeResult,
) -> (Vec<String>, u64) {
    let existing = marked_suggestion_indexes(&narsil.inner, index_name);
    let mut groups: Vec<String> = existing.keys().cloned().collect();
    let mut discarded = 0;
    for (group, phrases) in &result.groups {
        if existing.contains_key(group) {
            continue;
        }
        if groups.len() < setting.max_groups as usize {
            groups.push(group.clone());
        } else {
            discarded += phrases.len() as u64;
        }
    }
    (groups, discarded)
}

fn banned_now(narsil: &Narsil, index_name: &str) -> HashSet<String> {
    suggestion_state_of(&narsil.inner, index_name)
        .map(|state| state.banned.iter().cloned().collect())
        .unwrap_or_default()
}

/// Runs one build of `index_name`: merges the history, skips where it matches the last completed build, checks
/// each due phrase, and writes each group, undoing every write where one fails.
pub(crate) fn run_build(
    narsil: &Narsil,
    index_name: &str,
    setting: &ResolvedSetting,
    last_completed: Option<&BuildRecord>,
    now_ms: i64,
) -> Result<BuildOutcome> {
    let merged = merge_history(narsil, index_name, setting, now_ms)?;
    let sources_digest = sources_digest_of(&merged.sources);
    if last_completed.is_some_and(|record| record.sources_digest == sources_digest) {
        return Ok(BuildOutcome {
            status: QuerySuggestionsBuildStatus::Skipped,
            published: 0,
            removed: 0,
            discarded: 0,
            sources_digest,
        });
    }
    let cutoff = cutoff_day(now_ms, setting.retention_days);
    let only_add = merged
        .oldest_day
        .as_ref()
        .is_none_or(|oldest| *oldest > cutoff);
    let (groups, groups_discarded) = groups_to_write(narsil, index_name, setting, &merged.result);
    let mut due_by_group: BTreeMap<usize, (String, Vec<(String, u64)>)> = BTreeMap::new();
    for (order, group) in groups.into_iter().enumerate() {
        let mut due = Vec::new();
        for phrase in merged
            .result
            .groups
            .get(&group)
            .map_or(&[][..], Vec::as_slice)
        {
            if meets_min_results(narsil, index_name, setting, &phrase.phrase)? {
                due.push((phrase.phrase.clone(), phrase.count));
            }
        }
        due_by_group.insert(order, (group, due));
    }
    let runtime = &narsil.inner.suggestions;
    let mut undo: Vec<UndoStep> = Vec::new();
    let mut created: Vec<String> = Vec::new();
    let (mut published, mut removed) = (0, 0);
    let written = due_by_group.values().try_for_each(|(group, due)| {
        let _turn = runtime.write_turns.take(index_name);
        let name = ensure_suggestions_index(narsil, index_name, group, &mut created)?;
        let changes = write_group(
            narsil,
            &name,
            due,
            &banned_now(narsil, index_name),
            only_add,
            &mut undo,
        )?;
        published += changes.published;
        removed += changes.removed;
        Ok::<(), NarsilError>(())
    });
    if let Err(error) = written {
        {
            let _turn = runtime.write_turns.take(index_name);
            let _ = undo_writes(narsil, &undo, &banned_now(narsil, index_name));
        }
        for name in created {
            let _ = narsil.drop_index(&name);
        }
        return Err(error);
    }
    Ok(BuildOutcome {
        status: QuerySuggestionsBuildStatus::Completed,
        published,
        removed,
        discarded: merged.result.discarded + groups_discarded,
        sources_digest,
    })
}
