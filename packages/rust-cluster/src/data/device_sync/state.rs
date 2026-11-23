use narsil::replication::{CopyChangesState, CopyEpochStates, CopySyncState};
use narsil::{Map, Value};

use crate::constants::MAX_SAFE_INTEGER;

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

pub(super) fn epoch_states_of_settings(settings: Option<&Value>) -> CopyEpochStates {
    let Some(Value::Object(settings)) = settings else {
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
