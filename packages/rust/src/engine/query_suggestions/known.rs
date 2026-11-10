use std::collections::BTreeMap;
use std::sync::Arc;

use super::state::SuggestionState;
use crate::engine::EngineInner;
use crate::engine::index_lifecycle::HeldIndex;

/// Returns the suggestions state of the index called `name`, open or closed, without opening a closed one, or
/// `None` where the engine holds no index of that name.
pub(crate) fn suggestion_state_of(
    engine: &EngineInner,
    name: &str,
) -> Option<Arc<SuggestionState>> {
    engine.held_index(name).map(|held| match held {
        HeldIndex::Open(index) => index.suggestion_state(),
        HeldIndex::Closed(closed) => closed.suggestions,
    })
}

/// Returns the suggestions state of every index that the engine holds, open or closed, keyed by name, without
/// opening a closed one.
pub(crate) fn suggestion_states(engine: &EngineInner) -> BTreeMap<String, Arc<SuggestionState>> {
    let (open, closed) = engine.held_indexes();
    closed
        .into_iter()
        .map(|listing| (listing.name, listing.closed.suggestions))
        .chain(
            open.iter()
                .map(|index| (index.name.clone(), index.suggestion_state())),
        )
        .collect()
}
