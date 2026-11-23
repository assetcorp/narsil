use std::collections::HashSet;

use super::bans::{ban_list_from_input, normalise_ban, union_of_bans};
use super::constants::{
    DEFAULT_PREVIEW_LIMIT, MAX_MANUAL_SUGGESTION_COUNT, MAX_PREVIEW_LIMIT,
    MAX_SOURCE_INDEX_NAME_LENGTH,
};
use super::host::{IndexView, SuggestionsHost, wall_ms};
use super::operations::GROUP_FORMAT;
use super::phrase::{accepted_phrase, is_group, utf16_length};
use super::preview::preview_build;
use super::runtime::SuggestionsRuntime;
use super::setting::{require_fields_in_schema, validate_setting};
use super::stored_state::SuggestionState;
use super::suggestions_writer::{
    ORIGIN_MANUAL, ensure_suggestions_index, marked_suggestion_indexes, remove_suggestions,
    suggestion_document,
};
use super::timers::next_build_at;
use super::types::{
    ManualQuerySuggestion, QuerySuggestionsPreview, QuerySuggestionsSetting, QuerySuggestionsStatus,
};
use crate::error::{Result, index_not_found};
use crate::format::metadata_parts::config_invalid;
use crate::schema::CompiledSchema;
use crate::value::Value;

fn invalid_for(index_name: &str, message: String) -> crate::error::NarsilError {
    config_invalid(message).with_details([("indexName", Value::from(index_name))])
}

fn require_view(host: &dyn SuggestionsHost, index_name: &str) -> Result<IndexView> {
    host.view(index_name)
        .ok_or_else(|| index_not_found(index_name))
}

fn require_source_view(host: &dyn SuggestionsHost, index_name: &str) -> Result<IndexView> {
    let view = require_view(host, index_name)?;
    if view.state.source.is_some() {
        return Err(invalid_for(
            index_name,
            format!(
                "Index \"{index_name}\" is a suggestions index, so it takes no query suggestions"
            ),
        ));
    }
    if utf16_length(index_name) > MAX_SOURCE_INDEX_NAME_LENGTH {
        return Err(invalid_for(
            index_name,
            format!(
                "Index \"{index_name}\" has a name longer than {MAX_SOURCE_INDEX_NAME_LENGTH} characters, which leaves no room for the names of its suggestions indexes"
            ),
        ));
    }
    Ok(view)
}

fn require_acceptable(
    runtime: &SuggestionsRuntime,
    host: &dyn SuggestionsHost,
    index_name: &str,
    setting: &QuerySuggestionsSetting,
) -> Result<()> {
    let view = require_source_view(host, index_name)?;
    require_fields_in_schema(setting, &CompiledSchema::of(view.schema)?)?;
    if !setting.enabled {
        return Ok(());
    }
    if runtime.scrambler().is_none() {
        return Err(invalid_for(
            index_name,
            "This engine has no query suggestions key, so it cannot turn the feature on"
                .to_string(),
        ));
    }
    if view.has_sync {
        return Err(invalid_for(
            index_name,
            format!(
                "Index \"{index_name}\" has device sync on, and a device receives the whole index of one user while a suggestion comes from the searches of several people"
            ),
        ));
    }
    Ok(())
}

pub(crate) fn update_setting(
    runtime: &SuggestionsRuntime,
    host: &dyn SuggestionsHost,
    index_name: &str,
    setting: &QuerySuggestionsSetting,
) -> Result<()> {
    validate_setting(setting)?;
    require_acceptable(runtime, host, index_name, setting)?;
    host.update_state(index_name, &mut |current| {
        require_acceptable(runtime, host, index_name, setting)?;
        Ok(SuggestionState {
            setting: Some(setting.clone()),
            ..current.clone()
        })
    })?;
    if !setting.enabled {
        runtime.discard_history(host, index_name)?;
    }
    runtime.timers.rearm(runtime, host, index_name);
    Ok(())
}

pub(crate) fn status(
    runtime: &SuggestionsRuntime,
    host: &dyn SuggestionsHost,
    index_name: &str,
) -> Result<QuerySuggestionsStatus> {
    let view = require_view(host, index_name)?;
    let mut suggestion_indexes: Vec<String> = marked_suggestion_indexes(host, index_name)
        .into_values()
        .collect();
    suggestion_indexes.sort();
    Ok(QuerySuggestionsStatus {
        index_name: index_name.to_string(),
        setting: view.state.setting.clone(),
        last_build: runtime.builds.last_build(host, index_name),
        next_build_at: next_build_at(runtime, host, index_name, wall_ms()),
        suggestion_indexes,
    })
}

pub(crate) fn preview(
    runtime: &SuggestionsRuntime,
    host: &dyn SuggestionsHost,
    index_name: &str,
    limit: Option<u32>,
) -> Result<QuerySuggestionsPreview> {
    let max = limit.unwrap_or(DEFAULT_PREVIEW_LIMIT);
    if !(1..=MAX_PREVIEW_LIMIT).contains(&max) {
        return Err(config_invalid(format!(
            "The preview limit must be a whole number from 1 to {MAX_PREVIEW_LIMIT}"
        )));
    }
    preview_build(runtime, host, index_name, max as usize)
}

pub(crate) fn bans(host: &dyn SuggestionsHost, index_name: &str) -> Result<Vec<String>> {
    Ok(require_view(host, index_name)?.state.banned.clone())
}

fn ban_phrases(
    host: &dyn SuggestionsHost,
    index_name: &str,
    next: &dyn Fn(&[String]) -> Result<Vec<String>>,
) -> Result<(Vec<String>, Vec<String>)> {
    require_source_view(host, index_name)?;
    let mut added = Vec::new();
    let stored = host.update_state(index_name, &mut |current| {
        require_source_view(host, index_name)?;
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

fn remove_from_suggestions(
    host: &dyn SuggestionsHost,
    index_name: &str,
    phrases: &[String],
) -> Result<u64> {
    let mut holders = 0;
    if phrases.is_empty() {
        return Ok(holders);
    }
    for name in marked_suggestion_indexes(host, index_name).into_values() {
        if remove_suggestions(host, &name, phrases)? > 0 {
            holders += 1;
        }
    }
    Ok(holders)
}

pub(crate) fn update_bans(
    runtime: &SuggestionsRuntime,
    host: &dyn SuggestionsHost,
    index_name: &str,
    phrases: &[String],
) -> Result<Vec<String>> {
    let phrases = ban_list_from_input(phrases)?;
    let _writes = runtime.write_turns.take(index_name)?;
    let (stored, added) = ban_phrases(host, index_name, &|_| Ok(phrases.clone()))?;
    remove_from_suggestions(host, index_name, &added)?;
    Ok(stored)
}

pub(crate) fn remove_query(
    runtime: &SuggestionsRuntime,
    host: &dyn SuggestionsHost,
    index_name: &str,
    query: &str,
) -> Result<u64> {
    let phrase = normalise_ban(query)?;
    let _writes = runtime.write_turns.take(index_name)?;
    ban_phrases(host, index_name, &|current| {
        union_of_bans(current, std::slice::from_ref(&phrase))
    })?;
    remove_from_suggestions(host, index_name, std::slice::from_ref(&phrase))
}

pub(crate) fn add_suggestion(
    runtime: &SuggestionsRuntime,
    host: &dyn SuggestionsHost,
    index_name: &str,
    suggestion: &ManualQuerySuggestion,
) -> Result<String> {
    if !is_group(&suggestion.group) {
        return Err(config_invalid(format!(
            "A suggestion needs a group of {GROUP_FORMAT}"
        )));
    }
    let count = suggestion.count.unwrap_or(0);
    if count > MAX_MANUAL_SUGGESTION_COUNT {
        return Err(config_invalid(format!(
            "A suggestion's count must be a whole number from 0 to {MAX_MANUAL_SUGGESTION_COUNT}"
        )));
    }
    let _writes = runtime.write_turns.take(index_name)?;
    let view = require_source_view(host, index_name)?;
    let setting = view.state.setting.clone().unwrap_or_default().resolve();
    let Some(phrase) = accepted_phrase(&suggestion.query, &setting.phrase_limits()) else {
        return Err(config_invalid(
            "The suggestion is not a phrase that the setting of the index accepts",
        ));
    };
    if view.state.banned.contains(&phrase) {
        return Err(invalid_for(
            index_name,
            "The ban list of the index holds this phrase".to_string(),
        ));
    }
    let marked = marked_suggestion_indexes(host, index_name);
    if !marked.contains_key(&suggestion.group) && marked.len() >= setting.max_groups as usize {
        return Err(invalid_for(
            index_name,
            format!(
                "Index \"{index_name}\" already has {} groups",
                setting.max_groups
            ),
        ));
    }
    let name = ensure_suggestions_index(host, index_name, &suggestion.group, &mut Vec::new())?;
    let document = suggestion_document(&phrase, count as f64, ORIGIN_MANUAL);
    if host.has(&name, &phrase)? {
        host.update(&name, &phrase, document)?;
    } else {
        host.insert(&name, document)?;
    }
    Ok(name)
}
