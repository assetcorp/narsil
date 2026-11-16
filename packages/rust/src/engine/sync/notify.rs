use super::{sync_epoch_of, sync_is_on};
use crate::engine::EngineInner;
use crate::engine::events::FeedChange;
use crate::format::metadata::IndexMetadata;

fn recorded_metadata(engine: &EngineInner, name: &str) -> Option<IndexMetadata> {
    match engine.open_index_named(name) {
        Some(index) => index.log().map(|log| log.metadata(&index)),
        None => engine
            .durable
            .as_ref()?
            .stored_metadata(name)
            .ok()
            .flatten(),
    }
}

/// Returns the epoch that the feeds of the index called `name` follow, or `None` while neither device sync nor
/// change capture is on, reading a closed index's metadata file without opening the index.
pub(crate) fn feed_epoch(engine: &EngineInner, name: &str) -> Option<String> {
    sync_epoch_of(&recorded_metadata(engine, name)?).map(str::to_string)
}

/// Raises the settings event of the index called `name` where device sync is on for it.
pub(crate) fn announce_sync_settings(engine: &EngineInner, name: &str) {
    if recorded_metadata(engine, name).is_some_and(|metadata| sync_is_on(&metadata)) {
        engine.events.feed_changed(name, FeedChange::Settings);
    }
}

/// Runs `change` on the index called `name`, then raises the epoch event where the change gave the index a new
/// epoch, so that every feed of the index learns of it without waiting for its next read.
pub(crate) fn announcing_epoch<T>(
    engine: &EngineInner,
    name: &str,
    change: impl FnOnce() -> T,
) -> T {
    let before = feed_epoch(engine, name);
    let outcome = change();
    engine
        .events
        .epoch_moved(name, before, feed_epoch(engine, name));
    outcome
}
