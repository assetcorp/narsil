use std::sync::{Arc, OnceLock};

use super::feed::SyncFeedState;
use super::{sync_epoch_of, sync_is_on};
use crate::config::{PayloadFacts, configuration_payload};
use crate::engine::durable::metadata::config_of;
use crate::format::metadata::IndexMetadata;
use crate::synonyms::wire::synonym_rules_of;
use crate::value::Map;

const SYNC_SETTINGS_KEYS: [&str; 7] = [
    "language",
    "tokenizer",
    "stopWords",
    "stopWordList",
    "analysisRevision",
    "bm25",
    "synonyms",
];

const STORED_SYNONYMS_SOURCE: &str = "The synonym set in the index metadata is invalid: ";

/// What the engine knows of the device sync state of a closed index without opening it.
#[derive(Clone)]
pub(crate) enum ClosedSyncState {
    Off,
    On(SyncFeedState),
    Unread,
}

/// The device sync facts of a closed index: its feed state, and the head of each partition's log once the engine
/// has read it, which stays fixed until a call opens the index again.
#[derive(Clone)]
pub(crate) struct ClosedSync {
    pub(crate) state: ClosedSyncState,
    pub(crate) log_heads: Arc<OnceLock<Vec<u64>>>,
}

impl ClosedSync {
    pub(crate) fn new(state: ClosedSyncState) -> ClosedSync {
        ClosedSync {
            state,
            log_heads: Arc::new(OnceLock::new()),
        }
    }
}

/// Keeps the device settings of an index configuration payload, under the keys that a device applies to its copy.
pub(crate) fn sync_settings_of(configuration: &Map) -> Map {
    let mut settings = Map::new();
    for key in SYNC_SETTINGS_KEYS {
        if let Some(value) = configuration.get(key) {
            settings.insert(key, value.clone());
        }
    }
    settings
}

/// Reads the device sync state of a closed index from its stored metadata, as a reopen of the index would report it.
pub(crate) fn stored_sync_state(metadata: &IndexMetadata) -> ClosedSyncState {
    let Some(epoch) = sync_epoch_of(metadata).filter(|_| sync_is_on(metadata)) else {
        return ClosedSyncState::Off;
    };
    let Ok(config) = config_of(metadata) else {
        return ClosedSyncState::Unread;
    };
    let rules = match &metadata.synonyms {
        Some(value) => match synonym_rules_of(value, STORED_SYNONYMS_SOURCE) {
            Ok(rules) => rules,
            Err(_) => return ClosedSyncState::Unread,
        },
        None => Vec::new(),
    };
    let facts = PayloadFacts {
        language: &metadata.language,
        adapter_name: None,
        analysis_revision: metadata.analysis_revision.as_deref(),
        array_position_gap: None,
        synonyms: (!rules.is_empty()).then_some(rules.as_slice()),
        analysis_generation: metadata.analysis_generation.unwrap_or(0),
    };
    ClosedSyncState::On(SyncFeedState {
        epoch: epoch.to_string(),
        partition_count: metadata.partition_count,
        settings: sync_settings_of(&configuration_payload(&config, &facts)),
    })
}
