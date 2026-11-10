use std::sync::Arc;

use super::bans::union_of_bans;
use super::hooks::clear_leftovers_of_name;
use super::known::{suggestion_state_of, suggestion_states};
use super::restored_history::RestoredHistory;
use super::setting::invalid_setting;
use super::state::SuggestionState;
use super::types::QuerySuggestionsWarningReason;
use super::warnings::warn;
use super::writer::remove_suggestions;
use crate::engine::index::IndexState;
use crate::engine::sync::sync_is_on;
use crate::engine::{EngineInner, Narsil};
use crate::error::Result;

fn in_play(engine: &EngineInner, states: &[&SuggestionState]) -> bool {
    engine.suggestions.scrambler().is_some() || states.iter().any(|state| !state.is_empty())
}

/// Readies the suggestions state of a restored index before the engine stages its metadata: refuses suggestions
/// on an index that keeps device sync, keeps every phrase that the replaced index banned, and clears what an
/// earlier index of the name left behind where no index holds the name.
pub(crate) fn before_install(engine: &EngineInner, index: &IndexState) -> Result<()> {
    let restored = index.suggestion_state();
    let previous_open = engine.open_index_named(&index.name);
    let previous_closed = match &previous_open {
        Some(_) => None,
        None => engine.lifecycle.closed_index(&index.name),
    };
    let previous_state = match (&previous_open, &previous_closed) {
        (Some(open), _) => Some(open.suggestion_state()),
        (None, Some(closed)) => Some(Arc::clone(&closed.suggestions)),
        (None, None) => None,
    };
    let mut states = vec![&*restored];
    if let Some(state) = &previous_state {
        states.push(state);
    }
    if !in_play(engine, &states) {
        return Ok(());
    }
    let Some(previous_state) = previous_state else {
        clear_leftovers_of_name(engine, &index.name)?;
        return Ok(());
    };
    let previous_sync = match (&previous_open, &previous_closed) {
        (Some(open), _) => open
            .log()
            .is_some_and(|log| sync_is_on(&log.metadata(open))),
        (None, closed) => closed.as_ref().is_some_and(|closed| closed.sync_on),
    };
    if previous_sync && restored.enabled() {
        return Err(invalid_setting(format!(
            "Index \"{}\" has device sync on, and the archive turns popular query suggestions on, which a synced index cannot hold",
            index.name
        )));
    }
    let previous_bans = &previous_state.banned;
    if !previous_bans.is_empty() {
        let banned = union_of_bans(previous_bans, &restored.banned)?;
        index.replace_suggestion_state(SuggestionState {
            banned,
            ..(*restored).clone()
        });
    }
    Ok(())
}

fn apply_bans(narsil: &Narsil, index_name: &str) -> Result<()> {
    let engine = &*narsil.inner;
    let state = engine.index(index_name)?.suggestion_state();
    if !state.banned.is_empty() {
        for (other, other_state) in suggestion_states(engine) {
            let marked = other_state
                .source
                .as_ref()
                .is_some_and(|source| source.index == index_name);
            if other != index_name && marked {
                remove_suggestions(narsil, &other, &state.banned)?;
            }
        }
    }
    let Some(source) = state
        .source
        .as_ref()
        .filter(|source| source.index != index_name)
    else {
        return Ok(());
    };
    let source_bans = suggestion_state_of(engine, &source.index)
        .map(|source| source.banned.clone())
        .unwrap_or_default();
    if !source_bans.is_empty() {
        remove_suggestions(narsil, index_name, &source_bans)?;
    }
    Ok(())
}

/// Removes each banned phrase from the suggestions indexes that the restored index feeds, and from the restored
/// index where it is itself a suggestions index, warning where a removal fails.
pub(crate) fn after_activate(engine: &EngineInner, index_name: &str) {
    let Ok(index) = engine.index(index_name) else {
        return;
    };
    if !in_play(engine, &[&index.suggestion_state()]) {
        return;
    }
    let Some(inner) = engine.self_ref.upgrade() else {
        return;
    };
    if let Err(error) = apply_bans(&Narsil { inner }, index_name) {
        let message = Some(error.message().to_string());
        warn(
            engine,
            index_name,
            QuerySuggestionsWarningReason::BanRemovalFailed,
            None,
            message,
        );
    }
}

/// Settles the history of a restored index once it is in place: deletes it where the restored setting turns the
/// feature off, warns where the engine has no key, and otherwise replaces it with the history that the archive
/// carried. It then sets the next scheduled build from the restored setting.
pub(crate) fn after_install(
    engine: &EngineInner,
    index_name: &str,
    history: Option<RestoredHistory>,
) {
    let state = engine
        .index(index_name)
        .map(|index| index.suggestion_state())
        .unwrap_or_default();
    if !in_play(engine, &[&state]) && history.is_none() {
        return;
    }
    let runtime = &engine.suggestions;
    let settled = if !state.enabled() {
        runtime.discard_history(engine, index_name)
    } else if runtime.scrambler().is_none() {
        warn(
            engine,
            index_name,
            QuerySuggestionsWarningReason::NoKey,
            None,
            None,
        );
        Ok(())
    } else {
        history.map_or(Ok(()), |mut history| history.commit())
    };
    if let Err(error) = settled {
        let message = Some(error.message().to_string());
        warn(
            engine,
            index_name,
            QuerySuggestionsWarningReason::SaveFailed,
            None,
            message,
        );
    }
    runtime.timers.rearm(engine, index_name);
}
