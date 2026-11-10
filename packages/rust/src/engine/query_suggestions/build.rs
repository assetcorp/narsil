use std::collections::HashSet;
use std::time::Duration;

use super::build_record::{BuildRecord, MergedSource, sources_digest_of};
use super::constants::{MS_PER_SECOND, SOURCES_DIGEST_BYTES};
use super::day_store::cutoff_day;
use super::history_files::{HistoryRead, history_files_of, read_history_file};
use super::host::{suggestion_state_of, warn};
use super::merge::{DuePhrase, FileOutcome, MergeResult, MergeSettings, Merger};
use super::setting::ResolvedSetting;
use super::suggestions_writer::{
    UndoStep, ensure_suggestions_index, marked_suggestion_indexes, undo_writes, write_group,
};
use super::types::{QuerySuggestionsBuildStatus, QuerySuggestionsWarningReason};
use crate::engine::Narsil;
use crate::engine::query::params::{QueryParams, TermMatch};
use crate::error::{ErrorCode, NarsilError, Result};

pub(crate) struct MergedHistory {
    pub(crate) result: MergeResult,
    pub(crate) sources: Vec<MergedSource>,
    pub(crate) oldest_day: Option<String>,
}

pub(crate) struct BuildOutcome {
    pub(crate) status: QuerySuggestionsBuildStatus,
    pub(crate) published: u64,
    pub(crate) removed: u64,
    pub(crate) discarded: u64,
    pub(crate) sources_digest: [u8; SOURCES_DIGEST_BYTES],
}

fn banned_now(narsil: &Narsil, index_name: &str) -> HashSet<String> {
    suggestion_state_of(&narsil.inner, index_name)
        .map(|state| state.banned.iter().cloned().collect())
        .unwrap_or_default()
}

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
    let state = engine.reach_index(index_name)?.suggestion_state();
    let mut merger = Merger::new(
        MergeSettings {
            min_people: setting.min_people as usize,
            max_merge_phrases: setting.max_merge_phrases as usize,
            max_groups: setting.max_groups as usize,
            banned: state.banned.iter().cloned().collect(),
            memory_bytes: setting.merge_memory_bytes,
            fingerprint: *scrambler.fingerprint(),
        },
        marked_suggestion_indexes(engine, index_name)
            .into_keys()
            .collect(),
    );
    let listed = history_files_of(files, index_name).map_err(|error| {
        NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!(
                "The node cannot read its query history folder: {}",
                error.message()
            ),
        )
    })?;
    let mut sources = Vec::new();
    let mut oldest_day: Option<String> = None;
    for file in listed.into_iter().filter(|file| file.day >= cutoff) {
        let unreadable = match read_history_file(files, &file.key)? {
            HistoryRead::Missing => continue,
            HistoryRead::TooLong => QuerySuggestionsWarningReason::DamagedFile,
            HistoryRead::Bytes(bytes) => match merger.add_file(&bytes, &file.day)? {
                FileOutcome::Merged { day, saved_at } => {
                    if oldest_day.as_ref().is_none_or(|oldest| day < *oldest) {
                        oldest_day = Some(day);
                    }
                    sources.push(MergedSource {
                        key: file.key,
                        saved_at,
                    });
                    continue;
                }
                FileOutcome::Damaged => QuerySuggestionsWarningReason::DamagedFile,
                FileOutcome::OtherKey => QuerySuggestionsWarningReason::OtherKey,
            },
        };
        warn(engine, index_name, unreadable, Some(file.key), None);
    }
    Ok(MergedHistory {
        result: merger.result(),
        sources,
        oldest_day,
    })
}

pub(crate) fn meets_min_results(
    narsil: &Narsil,
    index_name: &str,
    setting: &ResolvedSetting,
    phrase: &str,
) -> Result<bool> {
    narsil.inner.suggestions.guard_stopping()?;
    let checked = narsil.preflight(
        index_name,
        &QueryParams {
            term: Some(phrase.to_string()),
            fields: Some(setting.fields.clone()),
            term_match: Some(TermMatch::All),
            ..QueryParams::default()
        },
    )?;
    std::thread::sleep(Duration::from_millis(
        MS_PER_SECOND / u64::from(setting.result_checks_per_second.max(1)),
    ));
    Ok(checked.count >= u64::from(setting.min_results))
}

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

pub(crate) fn due_phrases_of<'a>(result: &'a MergeResult, group: &str) -> &'a [DuePhrase] {
    result.groups.get(group).map_or(&[][..], Vec::as_slice)
}

pub(crate) fn run_build(
    narsil: &Narsil,
    index_name: &str,
    setting: &ResolvedSetting,
    last_completed: Option<&BuildRecord>,
    now_ms: i64,
) -> Result<BuildOutcome> {
    let merged = merge_history(narsil, index_name, setting, now_ms)?;
    let sources_digest = sources_digest_of(&merged.sources);
    let outcome = |status, published, removed, discarded| BuildOutcome {
        status,
        published,
        removed,
        discarded,
        sources_digest,
    };
    if last_completed.is_some_and(|record| record.sources_digest == sources_digest) {
        return Ok(outcome(QuerySuggestionsBuildStatus::Skipped, 0, 0, 0));
    }
    let cutoff = cutoff_day(now_ms, setting.retention_days);
    let only_add = merged
        .oldest_day
        .as_ref()
        .is_none_or(|oldest| *oldest > cutoff);
    let (groups, groups_discarded) = groups_to_write(narsil, index_name, setting, &merged.result);
    let mut due_by_group: Vec<(String, Vec<(String, u64)>)> = Vec::new();
    for group in groups {
        let mut due = Vec::new();
        for phrase in due_phrases_of(&merged.result, &group) {
            if meets_min_results(narsil, index_name, setting, &phrase.phrase)? {
                due.push((phrase.phrase.clone(), phrase.count));
            }
        }
        due_by_group.push((group, due));
    }
    let runtime = &narsil.inner.suggestions;
    let mut undo: Vec<UndoStep> = Vec::new();
    let mut created: Vec<String> = Vec::new();
    let (mut published, mut removed) = (0, 0);
    let written = due_by_group.iter().try_for_each(|(group, due)| {
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
    let discarded = merged.result.discarded + groups_discarded;
    Ok(outcome(
        QuerySuggestionsBuildStatus::Completed,
        published,
        removed,
        discarded,
    ))
}
