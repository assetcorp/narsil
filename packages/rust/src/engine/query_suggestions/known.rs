use std::collections::BTreeMap;
use std::sync::Arc;

use super::state::SuggestionState;
use crate::engine::EngineInner;

/// Returns the suggestions state of the index called `name`, open or closed, without opening a closed one, or
/// `None` where the engine holds no index of that name.
pub(crate) fn suggestion_state_of(
    engine: &EngineInner,
    name: &str,
) -> Option<Arc<SuggestionState>> {
    if let Some(index) = engine.open_index_named(name) {
        return Some(index.suggestion_state());
    }
    engine
        .lifecycle
        .closed_index(name)
        .map(|closed| closed.suggestions)
}

/// Returns the suggestions state of every index that the engine holds, open or closed, keyed by name, without
/// opening a closed one.
pub(crate) fn suggestion_states(engine: &EngineInner) -> BTreeMap<String, Arc<SuggestionState>> {
    let mut states: BTreeMap<String, Arc<SuggestionState>> = engine
        .lifecycle
        .closed_listing()
        .into_iter()
        .map(|(name, closed, _, _)| (name, closed.suggestions))
        .collect();
    for index in engine.index_list() {
        states.insert(index.name.clone(), index.suggestion_state());
    }
    states
}
