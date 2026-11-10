use std::sync::Arc;

use super::constants::MAX_SOURCE_INDEX_NAME_LENGTH;
use super::setting::invalid_setting;
use super::state::SuggestionState;
use crate::engine::EngineInner;
use crate::engine::index::IndexState;
use crate::engine::sync::sync_is_on;
use crate::error::Result;

/// The index whose suggestions state a change reads, with whether device sync is on for it.
pub(crate) struct IndexView<'a> {
    pub(crate) index: &'a IndexState,
    pub(crate) has_sync: bool,
}

/// Refuses a suggestions index as the source of suggestions, and a source whose name leaves no room for the names
/// of its suggestions indexes, with `CONFIG_INVALID`.
pub(crate) fn require_source(index: &IndexState) -> Result<()> {
    if index.suggestion_state().source.is_some() {
        return Err(invalid_setting(format!(
            "Index \"{}\" is a suggestions index, so it takes no query suggestions",
            index.name
        )));
    }
    if index.name.chars().map(char::len_utf16).sum::<usize>() > MAX_SOURCE_INDEX_NAME_LENGTH {
        return Err(invalid_setting(format!(
            "Index \"{}\" has a name longer than {MAX_SOURCE_INDEX_NAME_LENGTH} characters, which leaves no room for the names of its suggestions indexes",
            index.name
        )));
    }
    Ok(())
}

/// Replaces the suggestions state of `index_name` with the one that `change` returns, holding the name and the
/// write lock of the index, so that the metadata file holds the new state before any call reads it.
pub(crate) fn update_state(
    engine: &EngineInner,
    index_name: &str,
    change: impl FnOnce(&IndexView<'_>, &SuggestionState) -> Result<SuggestionState>,
) -> Result<SuggestionState> {
    let _name = engine.names.take(index_name);
    let index: Arc<IndexState> = engine.open_index(index_name)?;
    let _writer = index.lock_writes()?;
    let metadata = index.log().map(|log| log.metadata(&index));
    let view = IndexView {
        index: &index,
        has_sync: metadata.as_ref().is_some_and(sync_is_on),
    };
    let next = change(&view, &index.suggestion_state())?;
    if let (Some(log), Some(mut metadata)) = (index.log(), metadata) {
        next.write_metadata(&mut metadata);
        log.write_recorded(metadata)?;
    }
    index.replace_suggestion_state(next.clone());
    Ok(next)
}
