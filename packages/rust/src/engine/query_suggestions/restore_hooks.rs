use std::sync::Arc;

use super::bans::union_of_bans;
use super::constants::BUILD_WRITE_BATCH;
use super::engine_hooks::clear_leftovers_of_name;
use super::host::{locked, suggestion_state_of, suggestion_states, warn, warn_of_failure};
use super::restored_history::RestoredHistory;
use super::stored_state::SuggestionState;
use super::suggestions_writer::remove_suggestions;
use super::types::QuerySuggestionsWarningReason;
use crate::engine::index::IndexState;
use crate::engine::sync::sync_is_on;
use crate::engine::writes::remove_batch;
use crate::engine::{EngineInner, Narsil};
use crate::error::{ErrorCode, Result};
use crate::format::metadata_parts::config_invalid;

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
    let Some(previous_state) = previous_state else {
        return clear_leftovers_of_name(engine, &index.name);
    };
    let previous_sync = match (&previous_open, &previous_closed) {
        (Some(open), _) => open
            .log()
            .is_some_and(|log| sync_is_on(&log.metadata(open))),
        (None, closed) => closed.as_ref().is_some_and(|closed| closed.sync_on),
    };
    if previous_sync && restored.enabled() {
        return Err(config_invalid(format!(
            "Index \"{}\" has device sync on, and the archive turns popular query suggestions on, which a synced index cannot hold",
            index.name
        )));
    }
    if !previous_state.banned.is_empty() {
        let banned = union_of_bans(&previous_state.banned, &restored.banned)?;
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
    Ok(())
}

fn remove_source_bans_from(engine: &EngineInner, restored: &IndexState) -> Result<()> {
    let state = restored.suggestion_state();
    let Some(source) = state
        .source
        .as_ref()
        .filter(|source| source.index != restored.name)
    else {
        return Ok(());
    };
    let source_bans = suggestion_state_of(engine, &source.index)
        .map(|source| source.banned.clone())
        .unwrap_or_default();
    for batch in source_bans.chunks(BUILD_WRITE_BATCH) {
        let result = remove_batch(restored, batch.to_vec())?;
        if let Some(failure) = result
            .failed
            .iter()
            .find(|failure| failure.error.code() != ErrorCode::DOC_NOT_FOUND)
        {
            return Err(failure.error.clone());
        }
    }
    Ok(())
}

pub(crate) fn publish_without_source_bans(
    engine: &EngineInner,
    restored: &IndexState,
    publish: impl FnOnce(),
) {
    let _bans = locked(&engine.suggestions.ban_publication);
    if let Err(error) = remove_source_bans_from(engine, restored) {
        let reason = QuerySuggestionsWarningReason::BanRemovalFailed;
        warn_of_failure(engine, &restored.name, reason, &error);
    }
    publish();
}

pub(crate) fn after_activate(engine: &EngineInner, index_name: &str) {
    let Some(inner) = engine.self_ref.upgrade() else {
        return;
    };
    if let Err(error) = apply_bans(&Narsil { inner }, index_name) {
        let reason = QuerySuggestionsWarningReason::BanRemovalFailed;
        warn_of_failure(engine, index_name, reason, &error);
    }
}

pub(crate) fn after_install(
    engine: &EngineInner,
    index_name: &str,
    history: Option<RestoredHistory>,
) {
    let state = engine
        .index(index_name)
        .map(|index| index.suggestion_state())
        .unwrap_or_default();
    let runtime = &engine.suggestions;
    let settled = if !state.enabled() {
        runtime.discard_history(engine, index_name)
    } else if runtime.scrambler().is_none() {
        let reason = QuerySuggestionsWarningReason::NoKey;
        warn(engine, index_name, reason, None, None);
        Ok(())
    } else {
        history.map_or(Ok(()), |mut history| history.commit())
    };
    if let Err(error) = settled {
        let reason = QuerySuggestionsWarningReason::SaveFailed;
        warn_of_failure(engine, index_name, reason, &error);
    }
    runtime.timers.rearm(engine, index_name);
}
