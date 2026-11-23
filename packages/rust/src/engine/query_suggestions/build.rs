use std::collections::HashSet;
use std::time::Duration;

use super::build_record::{BuildRecord, MergedSource, sources_digest_of};
use super::constants::{MS_PER_SECOND, SOURCES_DIGEST_BYTES};
use super::day_store::cutoff_day;
use super::history_files::{
    HistoryFileName, HistoryRead, history_file_of, history_files_of, read_history_file,
};
use super::host::{RemoteFile, SuggestionsHost, warn};
use super::merge::{DuePhrase, FileOutcome, MergeResult, MergeSettings, Merger};
use super::runtime::SuggestionsRuntime;
use super::setting::ResolvedSetting;
use super::suggestions_writer::{
    UndoStep, ensure_suggestions_index, marked_suggestion_indexes, undo_writes, write_group,
};
use super::types::{QuerySuggestionsBuildStatus, QuerySuggestionsWarningReason};
use crate::engine::query::params::{QueryParams, TermMatch};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::Value;

pub(crate) struct MergedHistory {
    pub(crate) result: MergeResult,
    pub(crate) sources: Vec<MergedSource>,
    oldest_day: Option<String>,
    silent_nodes: usize,
}

struct MergedFiles {
    sources: Vec<MergedSource>,
    oldest_day: Option<String>,
}

struct HistoryFile {
    node_id: String,
    key: String,
    day: String,
    bytes: Vec<u8>,
}

struct MergeTarget<'a> {
    host: &'a dyn SuggestionsHost,
    index_name: &'a str,
    merger: Merger,
    merged: MergedFiles,
}

impl MergeTarget<'_> {
    fn merge_file(&mut self, file: HistoryFile, local: bool) -> Result<()> {
        let reason = match self.merger.add_file(&file.bytes, &file.day)? {
            FileOutcome::Merged { day, saved_at } => {
                let merged = &mut self.merged;
                if merged
                    .oldest_day
                    .as_ref()
                    .is_none_or(|oldest| day < *oldest)
                {
                    merged.oldest_day = Some(day);
                }
                merged.sources.push(MergedSource {
                    node_id: file.node_id,
                    key: file.key,
                    saved_at,
                });
                return Ok(());
            }
            FileOutcome::OtherIndex => {
                let host = self.host;
                warn(host, self.index_name, DAMAGED, Some(file.key.clone()), None);
                if local {
                    let _ = host.files().store().remove(&file.key);
                }
                return Ok(());
            }
            FileOutcome::Damaged => DAMAGED,
            FileOutcome::OtherKey => QuerySuggestionsWarningReason::OtherKey,
        };
        warn(self.host, self.index_name, reason, Some(file.key), None);
        Ok(())
    }

    fn merge_local_files(&mut self, files: &mut Vec<HistoryFileName>) -> Result<()> {
        let store = self.host.files().store();
        for name in std::mem::take(files) {
            let bytes = match read_history_file(store, &name.key)? {
                HistoryRead::Missing => continue,
                HistoryRead::TooLong => {
                    warn(self.host, self.index_name, DAMAGED, Some(name.key), None);
                    continue;
                }
                HistoryRead::Bytes(bytes) => bytes,
            };
            let file = HistoryFile {
                node_id: self.host.node_id().to_string(),
                key: name.key,
                day: name.day,
                bytes,
            };
            self.merge_file(file, true)?;
        }
        Ok(())
    }
}

const DAMAGED: QuerySuggestionsWarningReason = QuerySuggestionsWarningReason::DamagedFile;

pub(crate) struct BuildOutcome {
    pub(crate) status: QuerySuggestionsBuildStatus,
    pub(crate) published: u64,
    pub(crate) removed: u64,
    pub(crate) discarded: u64,
    pub(crate) sources_digest: [u8; SOURCES_DIGEST_BYTES],
}

fn banned_now(host: &dyn SuggestionsHost, index_name: &str) -> HashSet<String> {
    host.state(index_name)
        .map(|state| state.banned.iter().cloned().collect())
        .unwrap_or_default()
}

pub(crate) fn merge_history(
    runtime: &SuggestionsRuntime,
    host: &dyn SuggestionsHost,
    index_name: &str,
    setting: &ResolvedSetting,
    now_ms: i64,
) -> Result<MergedHistory> {
    let scrambler = runtime.require_scrambler()?;
    runtime.save_day(host, index_name);
    let cutoff = cutoff_day(now_ms, setting.retention_days);
    let state = host.require_state(index_name)?;
    let merger = Merger::new(
        MergeSettings {
            min_people: setting.min_people as usize,
            max_merge_phrases: setting.max_merge_phrases as usize,
            max_groups: setting.max_groups as usize,
            banned: state.banned.iter().cloned().collect(),
            memory_bytes: setting.merge_memory_bytes,
            fingerprint: *scrambler.fingerprint(),
            index_uuid: host.index_uuid(index_name),
            clustered: host.clustered(),
        },
        marked_suggestion_indexes(host, index_name)
            .into_keys()
            .collect(),
    );
    let listed = history_files_of(host.files().store(), index_name).map_err(|error| {
        NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!(
                "The node cannot read its query history folder: {}",
                error.message()
            ),
        )
        .with_details([("cause", Value::from(error.message()))])
    })?;
    let mut local_files: Vec<HistoryFileName> = listed
        .into_iter()
        .filter(|file| file.day >= cutoff)
        .collect();
    local_files.sort_by(|left, right| left.key.cmp(&right.key));
    let mut target = MergeTarget {
        host,
        index_name,
        merger,
        merged: MergedFiles {
            sources: Vec::new(),
            oldest_day: None,
        },
    };
    let mut silent_nodes = 0;
    for remote in host.remote_history(index_name) {
        let (node_id, key, bytes) = match remote {
            RemoteFile::Silent { .. } => {
                silent_nodes += 1;
                continue;
            }
            RemoteFile::File {
                node_id,
                key,
                bytes,
            } => (node_id, key, bytes),
        };
        if node_id.as_str() > host.node_id() {
            target.merge_local_files(&mut local_files)?;
        }
        let Some(name) = history_file_of(index_name, &key) else {
            continue;
        };
        if name.day < cutoff {
            continue;
        }
        let file = HistoryFile {
            node_id,
            key,
            day: name.day,
            bytes,
        };
        target.merge_file(file, false)?;
    }
    target.merge_local_files(&mut local_files)?;
    Ok(MergedHistory {
        result: target.merger.result(),
        sources: target.merged.sources,
        oldest_day: target.merged.oldest_day,
        silent_nodes,
    })
}

pub(crate) fn meets_min_results(
    runtime: &SuggestionsRuntime,
    host: &dyn SuggestionsHost,
    index_name: &str,
    setting: &ResolvedSetting,
    phrase: &str,
) -> Result<bool> {
    runtime.guard_stopping()?;
    let checked = host.preflight(
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
    host: &dyn SuggestionsHost,
    index_name: &str,
    setting: &ResolvedSetting,
    result: &MergeResult,
) -> (Vec<String>, u64) {
    let existing = marked_suggestion_indexes(host, index_name);
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
    runtime: &SuggestionsRuntime,
    host: &dyn SuggestionsHost,
    index_name: &str,
    setting: &ResolvedSetting,
    last_completed: Option<&BuildRecord>,
    now_ms: i64,
) -> Result<BuildOutcome> {
    let merged = merge_history(runtime, host, index_name, setting, now_ms)?;
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
    let only_add = merged.silent_nodes > 0
        || merged
            .oldest_day
            .as_ref()
            .is_none_or(|oldest| *oldest > cutoff);
    let (groups, groups_discarded) = groups_to_write(host, index_name, setting, &merged.result);
    let mut due_by_group: Vec<(String, Vec<(String, u64)>)> = Vec::new();
    for group in groups {
        let mut due = Vec::new();
        for phrase in due_phrases_of(&merged.result, &group) {
            if meets_min_results(runtime, host, index_name, setting, &phrase.phrase)? {
                due.push((phrase.phrase.clone(), phrase.count));
            }
        }
        due_by_group.push((group, due));
    }
    let mut undo: Vec<UndoStep> = Vec::new();
    let mut created: Vec<String> = Vec::new();
    let (mut published, mut removed) = (0, 0);
    let written = due_by_group.iter().try_for_each(|(group, due)| {
        let _turn = runtime.write_turns.take(index_name)?;
        let name = ensure_suggestions_index(host, index_name, group, &mut created)?;
        let changes = write_group(
            host,
            &name,
            due,
            &banned_now(host, index_name),
            only_add,
            &mut undo,
        )?;
        published += changes.published;
        removed += changes.removed;
        Ok::<(), NarsilError>(())
    });
    if let Err(error) = written {
        if let Ok(_turn) = runtime.write_turns.take(index_name) {
            let _ = undo_writes(host, &undo, &banned_now(host, index_name));
        }
        for name in created {
            let _ = host.drop_index(&name);
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
