use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use super::build_record::{BuildRecord, decode_build_record, encode_build_record};
use super::history_files::{HistoryRead, build_record_key, read_history_file};
use super::stored_state::SuggestionState;
use super::types::QuerySuggestionsWarningReason;
use crate::durability::platform::now_ms;
use crate::engine::EngineInner;
use crate::engine::events::NarsilEvent;
use crate::engine::index::IndexState;
use crate::engine::index_lifecycle::HeldIndex;
use crate::engine::sync::sync_is_on;
use crate::error::{NarsilError, Result};

pub(crate) struct IndexView<'a> {
    pub(crate) index: &'a IndexState,
    pub(crate) has_sync: bool,
}

pub(crate) fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn wall_ms() -> i64 {
    i64::try_from(now_ms()).unwrap_or(i64::MAX)
}

pub(crate) fn suggestion_state_of(
    engine: &EngineInner,
    name: &str,
) -> Option<Arc<SuggestionState>> {
    engine.held_index(name).map(|held| match held {
        HeldIndex::Open(index) => index.suggestion_state(),
        HeldIndex::Closed(closed) => closed.suggestions,
    })
}

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

pub(crate) fn read_build_record(engine: &EngineInner, index_name: &str) -> Option<BuildRecord> {
    let files = engine.suggestions.files(engine);
    match read_history_file(files, &build_record_key(index_name)) {
        Ok(HistoryRead::Bytes(bytes)) => decode_build_record(&bytes),
        _ => None,
    }
}

pub(crate) fn write_build_record(
    engine: &EngineInner,
    index_name: &str,
    record: &BuildRecord,
) -> Result<()> {
    let bytes = encode_build_record(record)?;
    let files = engine.suggestions.files(engine);
    files.write_commit(&build_record_key(index_name), &bytes)
}

pub(crate) fn warn(
    engine: &EngineInner,
    index_name: &str,
    reason: QuerySuggestionsWarningReason,
    file: Option<String>,
    message: Option<String>,
) {
    engine.events.emit(NarsilEvent::QuerySuggestionsWarning {
        index_name: index_name.to_string(),
        reason,
        file,
        message,
    });
}

pub(crate) fn warn_of_failure(
    engine: &EngineInner,
    index_name: &str,
    reason: QuerySuggestionsWarningReason,
    error: &NarsilError,
) {
    let message = Some(error.message().to_string());
    warn(engine, index_name, reason, None, message);
}
