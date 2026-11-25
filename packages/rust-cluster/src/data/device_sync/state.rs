use narsil::replication::{CopyChangesState, CopyEpochStates, CopySyncState};
use narsil::{FeedChange, Map, Value};

use super::held::HeldSyncIndex;
use crate::constants::MAX_SAFE_INTEGER;

const COMPARED_FEED_SETTINGS: [&str; 5] = [
    "language",
    "tokenizer",
    "stopWords",
    "stopWordList",
    "foldMarks",
];

fn feature<'s>(settings: &'s Map, key: &str) -> Option<&'s Map> {
    match settings.get(key) {
        Some(Value::Object(feature)) if feature.get("enabled") == Some(&Value::Bool(true)) => {
            Some(feature)
        }
        _ => None,
    }
}

fn limit(feature: &Map, key: &str) -> Option<u64> {
    match feature.get(key) {
        Some(Value::Number(number))
            if number.is_finite()
                && number.fract() == 0.0
                && *number >= 1.0
                && *number <= MAX_SAFE_INTEGER as f64 =>
        {
            Some(*number as u64)
        }
        _ => None,
    }
}

fn sync_state_of_settings(settings: &Map, epoch: &str) -> Option<CopySyncState> {
    let sync = feature(settings, "sync")?;
    Some(CopySyncState {
        history_max_age_ms: limit(sync, "historyMaxAgeMs"),
        history_max_bytes: limit(sync, "historyMaxBytes"),
        active: settings.get("syncActive") == Some(&Value::Bool(true)),
        epoch: epoch.to_string(),
    })
}

fn changes_state_of_settings(settings: &Map, epoch: &str) -> Option<CopyChangesState> {
    let changes = feature(settings, "changes")?;
    Some(CopyChangesState {
        previous_document: changes.get("previousDocument") == Some(&Value::Bool(true)),
        history_max_age_ms: limit(changes, "historyMaxAgeMs"),
        history_max_bytes: limit(changes, "historyMaxBytes"),
        epoch: epoch.to_string(),
    })
}

pub(super) fn epoch_states_of_settings(settings: Option<&Map>) -> CopyEpochStates {
    let Some(settings) = settings else {
        return CopyEpochStates::default();
    };
    let Some(Value::String(epoch)) = settings.get("syncEpoch") else {
        return CopyEpochStates::default();
    };
    CopyEpochStates {
        sync: sync_state_of_settings(settings, epoch),
        changes: changes_state_of_settings(settings, epoch),
    }
}

fn same_feed_settings(held: &HeldSyncIndex, next: &HeldSyncIndex) -> bool {
    let field = |held: &HeldSyncIndex, key: &str| -> Option<Value> {
        held.settings
            .as_ref()
            .and_then(|settings| settings.get(key))
            .cloned()
    };
    let bm25_revision = |held: &HeldSyncIndex| match field(held, "bm25Revision") {
        Some(Value::Number(revision)) => revision,
        _ => 0.0,
    };
    held.synonyms_generation == next.synonyms_generation
        && COMPARED_FEED_SETTINGS
            .iter()
            .all(|key| field(held, key) == field(next, key))
        && bm25_revision(held) == bm25_revision(next)
}

pub(super) fn change_between(
    held: Option<&HeldSyncIndex>,
    next: Option<&HeldSyncIndex>,
) -> Option<FeedChange> {
    let held = held?;
    let before = held.states.sync.as_ref()?;
    let Some(next) = next.filter(|next| next.index_uuid == held.index_uuid) else {
        return Some(FeedChange::Dropped);
    };
    let Some(after) = next.states.sync.as_ref() else {
        return Some(FeedChange::SyncOff);
    };
    if after.epoch != before.epoch || next.serving.partition_count != held.serving.partition_count {
        return Some(FeedChange::Epoch);
    }
    (!same_feed_settings(held, next)).then_some(FeedChange::Settings)
}

pub(super) fn changes_change_between(
    held: Option<&HeldSyncIndex>,
    next: Option<&HeldSyncIndex>,
) -> Option<FeedChange> {
    let held = held?;
    let before = held.states.changes.as_ref()?;
    let Some(next) = next.filter(|next| next.index_uuid == held.index_uuid) else {
        return Some(FeedChange::Dropped);
    };
    let Some(after) = next.states.changes.as_ref() else {
        return Some(FeedChange::ChangesOff);
    };
    if after.epoch != before.epoch || next.serving.partition_count != held.serving.partition_count {
        return Some(FeedChange::Epoch);
    }
    (before.previous_document && !after.previous_document)
        .then_some(FeedChange::PreviousDocumentOff)
}
