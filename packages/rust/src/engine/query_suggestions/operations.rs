use std::collections::{HashMap, HashSet};

use super::bans::{ban_list_from_input, normalise_ban, union_of_bans};
use super::build::{groups_to_write, meets_min_results, merge_history};
use super::constants::{DEFAULT_PREVIEW_LIMIT, MAX_MANUAL_SUGGESTION_COUNT, MAX_PREVIEW_LIMIT};
use super::merge::compare_utf16;
use super::phrase::{accepted_phrase, is_group};
use super::setting::{
    QuerySuggestionsSetting, invalid_setting, require_fields_in_schema, validate_setting,
};
use super::state::SuggestionState;
use super::stored_state::{IndexView, require_source, update_state};
use super::timers::next_build_at;
use super::types::{
    ManualQuerySuggestion, QuerySuggestionPreviewEntry, QuerySuggestionsBuild,
    QuerySuggestionsBuildTrigger, QuerySuggestionsPreview, QuerySuggestionsStatus,
    RecordQueryResult, RecordedQuery,
};
use super::writer::{
    ORIGIN_MANUAL, ensure_suggestions_index, marked_suggestion_indexes, remove_suggestions,
    suggestion_document, suggestions_index_name,
};
use crate::durability::platform::now_ms;
use crate::engine::Narsil;
use crate::error::Result;

const GROUP_FORMAT: &str =
    "1 to 32 letters, digits, '_', and '-', starting with a letter or a digit";

/// The popular query suggestions of an engine, which [`Narsil::query_suggestions`] returns.
///
/// The engine counts each search that a person follows with a click, and a build publishes each phrase that
/// enough people searched into a suggestions index per group, which a prefix search reads.
pub struct QuerySuggestions<'a> {
    narsil: &'a Narsil,
}

impl Narsil {
    /// Returns the popular query suggestions of the engine.
    pub fn query_suggestions(&self) -> QuerySuggestions<'_> {
        QuerySuggestions { narsil: self }
    }
}

fn require_acceptable(
    narsil: &Narsil,
    view: &IndexView<'_>,
    setting: &QuerySuggestionsSetting,
) -> Result<()> {
    require_source(view.index)?;
    require_fields_in_schema(setting, &view.index.schema)?;
    if !setting.enabled {
        return Ok(());
    }
    if narsil.inner.suggestions.scrambler().is_none() {
        return Err(invalid_setting(
            "This engine has no query suggestions key, so it cannot turn the feature on",
        ));
    }
    if view.has_sync {
        return Err(invalid_setting(format!(
            "Index \"{}\" has device sync on, and a device receives the whole index of one user while a suggestion comes from the searches of several people",
            view.index.name
        )));
    }
    Ok(())
}

fn preview_order(
    left: &QuerySuggestionPreviewEntry,
    right: &QuerySuggestionPreviewEntry,
) -> std::cmp::Ordering {
    right
        .count
        .cmp(&left.count)
        .then_with(|| compare_utf16(&left.group, &right.group))
        .then_with(|| compare_utf16(&left.query, &right.query))
}

impl QuerySuggestions<'_> {
    /// Counts one search of `index` that a person followed with a click, and returns what counting it did.
    ///
    /// The engine stores the phrase in normal form, and stores the person only as a scrambled ID. Fails with
    /// `INDEX_NOT_FOUND` for a missing index, with `QUERY_SUGGESTIONS_NOT_ENABLED` where the feature is off, and with
    /// `INSTANCE_SHUT_DOWN` once the engine shuts down.
    pub fn record_query(&self, index: &str, query: &RecordedQuery) -> Result<RecordQueryResult> {
        let engine = &self.narsil.inner;
        engine.guard_shutdown()?;
        engine.suggestions.record(engine, index, query)
    }

    /// Replaces the popular query suggestions setting of `index`. Turning the feature off deletes every count and
    /// history file of the index.
    ///
    /// Fails with `CONFIG_INVALID` where the setting breaks a rule, where a field is not a `string` or `string[]`
    /// field of the schema, where the index is a suggestions index or has device sync on, and where the setting
    /// turns the feature on while the engine has no key, and with `INDEX_NOT_FOUND` for a missing index.
    pub fn update_setting(&self, index: &str, setting: &QuerySuggestionsSetting) -> Result<()> {
        let engine = &self.narsil.inner;
        engine.guard_shutdown()?;
        validate_setting(setting)?;
        update_state(engine, index, |view, current| {
            require_acceptable(self.narsil, view, setting)?;
            Ok(SuggestionState {
                setting: Some(setting.clone()),
                ..current.clone()
            })
        })?;
        if !setting.enabled {
            engine.suggestions.discard_history(engine, index)?;
        }
        engine.suggestions.timers.rearm(engine, index);
        Ok(())
    }

    /// Returns the setting of `index`, its build under way or its last build, when its schedule next starts a
    /// build, and its suggestions indexes. Fails with `INDEX_NOT_FOUND` for a missing index.
    pub fn status(&self, index: &str) -> Result<QuerySuggestionsStatus> {
        let engine = &self.narsil.inner;
        let state = engine.open_index(index)?.suggestion_state();
        let mut suggestion_indexes: Vec<String> = marked_suggestion_indexes(engine, index)
            .into_values()
            .collect();
        suggestion_indexes.sort();
        Ok(QuerySuggestionsStatus {
            index_name: index.to_string(),
            setting: state.setting.clone(),
            last_build: engine.suggestions.builds.last_build(engine, index),
            next_build_at: next_build_at(
                engine,
                index,
                i64::try_from(now_ms()).unwrap_or(i64::MAX),
            ),
            suggestion_indexes,
        })
    }

    /// Runs a build of `index` on the calling thread and returns how it ended, or a skipped build at once where
    /// another build of the index is under way.
    ///
    /// Fails with `INDEX_NOT_FOUND` for a missing index, with `QUERY_SUGGESTIONS_NOT_ENABLED` where the feature is
    /// off, and with `CONFIG_INVALID` where the engine has no key. A build that fails records the error code.
    pub fn build(&self, index: &str) -> Result<QuerySuggestionsBuild> {
        self.narsil.inner.guard_shutdown()?;
        self.narsil.inner.suggestions.builds.start(
            self.narsil,
            index,
            QuerySuggestionsBuildTrigger::Caller,
        )
    }

    /// Returns up to `limit` phrases, 100 where `None`, that a build of `index` would publish now, most searched
    /// first, without writing anything.
    ///
    /// Fails with `CONFIG_INVALID` for a limit outside 1 to 1,000 or where the engine has no key, and as
    /// [`QuerySuggestions::build`] does otherwise.
    pub fn preview(&self, index: &str, limit: Option<u32>) -> Result<QuerySuggestionsPreview> {
        let max = limit.unwrap_or(DEFAULT_PREVIEW_LIMIT);
        if !(1..=MAX_PREVIEW_LIMIT).contains(&max) {
            return Err(invalid_setting(format!(
                "The preview limit must be a whole number from 1 to {MAX_PREVIEW_LIMIT}"
            )));
        }
        let engine = &self.narsil.inner;
        engine.guard_shutdown()?;
        let setting = engine.suggestions.enabled_setting(engine, index)?;
        engine.suggestions.require_scrambler()?;
        let now = i64::try_from(now_ms()).unwrap_or(i64::MAX);
        let merged = merge_history(self.narsil, index, &setting, now)?;
        let (groups, _) = groups_to_write(self.narsil, index, &setting, &merged.result);
        let banned: HashSet<String> = engine
            .open_index(index)?
            .suggestion_state()
            .banned
            .iter()
            .cloned()
            .collect();
        let mut candidates = Vec::new();
        for group in groups {
            for phrase in merged
                .result
                .groups
                .get(&group)
                .map_or(&[][..], Vec::as_slice)
            {
                if !banned.contains(&phrase.phrase) {
                    candidates.push(QuerySuggestionPreviewEntry {
                        group: group.clone(),
                        query: phrase.phrase.clone(),
                        count: phrase.count,
                    });
                }
            }
        }
        candidates.sort_by(preview_order);
        let mut checked: HashMap<String, bool> = HashMap::new();
        let mut entries = Vec::new();
        let mut next = 0;
        while next < candidates.len() && entries.len() < max as usize {
            let Some(candidate) = candidates.get(next) else {
                break;
            };
            next += 1;
            let passes = match checked.get(&candidate.query) {
                Some(passes) => *passes,
                None => {
                    let passes = meets_min_results(self.narsil, index, &setting, &candidate.query)?;
                    checked.insert(candidate.query.clone(), passes);
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

    /// Returns the ban list of `index`. Fails with `INDEX_NOT_FOUND` for a missing index.
    pub fn bans(&self, index: &str) -> Result<Vec<String>> {
        Ok(self
            .narsil
            .inner
            .open_index(index)?
            .suggestion_state()
            .banned
            .clone())
    }

    /// Replaces the ban list of `index` with `phrases` in normal form, removes each newly banned phrase from every
    /// suggestions index of `index`, and returns the stored list.
    ///
    /// Fails with `CONFIG_INVALID` for a list of more than 1,000 phrases, a list that encodes to more than 256 KiB,
    /// a phrase that is not a phrase, and a suggestions index, and with `INDEX_NOT_FOUND` for a missing index.
    pub fn update_bans(&self, index: &str, phrases: &[String]) -> Result<Vec<String>> {
        let engine = &self.narsil.inner;
        engine.guard_shutdown()?;
        let phrases = ban_list_from_input(phrases)?;
        let _writes = engine.suggestions.write_turns.take(index);
        let (stored, added) = self.ban_phrases(index, |_| Ok(phrases))?;
        self.remove_from_suggestions(index, &added)?;
        Ok(stored)
    }

    /// Bans `query` for `index` and removes it from every suggestions index of `index`, returning the number of
    /// suggestions indexes that held it.
    ///
    /// Fails with `CONFIG_INVALID` for a query that is not a phrase, for a ban list that already holds as many
    /// phrases as it may, and for a suggestions index, and with `INDEX_NOT_FOUND` for a missing index.
    pub fn remove_query(&self, index: &str, query: &str) -> Result<u64> {
        let engine = &self.narsil.inner;
        engine.guard_shutdown()?;
        let phrase = normalise_ban(query)?;
        let _writes = engine.suggestions.write_turns.take(index);
        self.ban_phrases(index, |current| {
            union_of_bans(current, std::slice::from_ref(&phrase))
        })?;
        self.remove_from_suggestions(index, std::slice::from_ref(&phrase))
    }

    /// Adds a suggestion by hand to the suggestions index of its group, creating that index where it is missing,
    /// and returns the name of that index. A build keeps a manual suggestion whatever the searches say.
    ///
    /// Fails with `CONFIG_INVALID` for a group outside its format, a count above 4,294,967,295, a query that the
    /// setting of the index refuses or that its ban list holds, a new group past `maxGroups`, and a suggestions
    /// index, and with `INDEX_NOT_FOUND` for a missing index.
    pub fn add_suggestion(
        &self,
        index: &str,
        suggestion: &ManualQuerySuggestion,
    ) -> Result<String> {
        let engine = &self.narsil.inner;
        engine.guard_shutdown()?;
        if !is_group(&suggestion.group) {
            return Err(invalid_setting(format!(
                "A suggestion needs a group of {GROUP_FORMAT}"
            )));
        }
        let count = suggestion.count.unwrap_or(0);
        if count > MAX_MANUAL_SUGGESTION_COUNT {
            return Err(invalid_setting(format!(
                "A suggestion's count must be a whole number from 0 to {MAX_MANUAL_SUGGESTION_COUNT}"
            )));
        }
        let _writes = engine.suggestions.write_turns.take(index);
        let source = engine.open_index(index)?;
        require_source(&source)?;
        let state = source.suggestion_state();
        let setting = state.setting.clone().unwrap_or_default().resolve();
        let Some(phrase) = accepted_phrase(&suggestion.query, &setting.phrase_limits()) else {
            return Err(invalid_setting(
                "The suggestion is not a phrase that the setting of the index accepts",
            ));
        };
        if state.banned.contains(&phrase) {
            return Err(invalid_setting(format!(
                "The ban list of index \"{index}\" holds this phrase"
            )));
        }
        let marked = marked_suggestion_indexes(engine, index);
        if !marked.contains_key(&suggestion.group) && marked.len() >= setting.max_groups as usize {
            return Err(invalid_setting(format!(
                "Index \"{index}\" already has {} groups",
                setting.max_groups
            )));
        }
        let name =
            ensure_suggestions_index(self.narsil, index, &suggestion.group, &mut Vec::new())?;
        let document = suggestion_document(&phrase, count as f64, ORIGIN_MANUAL);
        if self.narsil.has(&name, &phrase)? {
            self.narsil.update(&name, &phrase, document)?;
        } else {
            self.narsil.insert(&name, document, None)?;
        }
        Ok(name)
    }

    /// Returns the name of the suggestions index of `group` for `index`. Fails with `CONFIG_INVALID` for a group
    /// outside its format.
    pub fn suggestions_index_name(&self, index: &str, group: &str) -> Result<String> {
        if !is_group(group) {
            return Err(invalid_setting(format!("A group holds {GROUP_FORMAT}")));
        }
        Ok(suggestions_index_name(index, group))
    }

    fn ban_phrases(
        &self,
        index: &str,
        next: impl FnOnce(&[String]) -> Result<Vec<String>>,
    ) -> Result<(Vec<String>, Vec<String>)> {
        let mut added = Vec::new();
        let stored = update_state(&self.narsil.inner, index, |view, current| {
            require_source(view.index)?;
            let stored = next(&current.banned)?;
            let before: HashSet<&String> = current.banned.iter().collect();
            added = stored
                .iter()
                .filter(|phrase| !before.contains(phrase))
                .cloned()
                .collect();
            Ok(SuggestionState {
                banned: stored,
                ..current.clone()
            })
        })?;
        Ok((stored.banned, added))
    }

    fn remove_from_suggestions(&self, index: &str, phrases: &[String]) -> Result<u64> {
        let mut holders = 0;
        if phrases.is_empty() {
            return Ok(holders);
        }
        for name in marked_suggestion_indexes(&self.narsil.inner, index).into_values() {
            if remove_suggestions(self.narsil, &name, phrases)? > 0 {
                holders += 1;
            }
        }
        Ok(holders)
    }
}
