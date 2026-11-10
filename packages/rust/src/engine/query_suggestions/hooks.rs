use super::history::remove_history_folder;
use super::known::suggestion_states;
use crate::engine::{EngineInner, lifecycle};
use crate::error::{ErrorCode, Result};

fn suggestion_indexes_of(engine: &EngineInner, source_name: &str) -> Vec<String> {
    suggestion_states(engine)
        .into_iter()
        .filter(|(name, state)| {
            name != source_name
                && state
                    .source
                    .as_ref()
                    .is_some_and(|source| source.index == source_name)
        })
        .map(|(name, _)| name)
        .collect()
}

/// Drops every suggestions index whose marker names `source_name`, skipping each that another call dropped first.
pub(crate) fn drop_suggestion_indexes_of(engine: &EngineInner, source_name: &str) -> Result<()> {
    for name in suggestion_indexes_of(engine, source_name) {
        match lifecycle::drop_index(engine, &name) {
            Err(error) if error.code() != ErrorCode::INDEX_NOT_FOUND => return Err(error),
            _ => {}
        }
    }
    Ok(())
}

/// Clears what an earlier index of the same name left behind before a new index takes `name`: its suggestions
/// indexes and its query history.
pub(crate) fn clear_leftovers_of_name(engine: &EngineInner, name: &str) -> Result<()> {
    drop_suggestion_indexes_of(engine, name)?;
    remove_history_folder(engine.suggestions.files(engine), name)
}
