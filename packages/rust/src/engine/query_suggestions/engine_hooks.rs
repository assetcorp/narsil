use super::history_files::remove_history_folder;
use super::host::suggestion_states;
use crate::engine::{EngineInner, lifecycle};
use crate::error::{ErrorCode, Result};

pub(crate) fn drop_suggestion_indexes_of(engine: &EngineInner, source_name: &str) -> Result<()> {
    for (name, state) in suggestion_states(engine) {
        let marked = state
            .source
            .as_ref()
            .is_some_and(|source| source.index == source_name);
        if name == source_name || !marked {
            continue;
        }
        match lifecycle::drop_index(engine, &name) {
            Err(error) if error.code() != ErrorCode::INDEX_NOT_FOUND => return Err(error),
            _ => {}
        }
    }
    Ok(())
}

pub(crate) fn clear_leftovers_of_name(engine: &EngineInner, name: &str) -> Result<()> {
    drop_suggestion_indexes_of(engine, name)?;
    remove_history_folder(engine.suggestions.files(engine), name)
}
