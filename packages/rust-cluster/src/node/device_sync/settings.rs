use narsil::{ChangesSetting, ChangesStatus, Map, SyncSetting, SyncStatus, Value};

use crate::constants::{MAX_SAFE_INTEGER, SYNC_EPOCH_BYTES};
use crate::error::{ClusterError, ClusterResult, codes};

pub(super) const SYNC_FIELDS: [&str; 4] = ["sync", "syncActive", "syncEpoch", "changes"];

pub(super) fn require_limit(feature: &str, name: &str, value: Option<u64>) -> ClusterResult<()> {
    match value {
        Some(limit) if limit == 0 || limit > MAX_SAFE_INTEGER => Err(ClusterError::new(
            codes::CONFIG_INVALID,
            format!("The {feature} setting {name} must be a positive whole number"),
        )
        .with_detail(name, Value::Number(limit as f64))),
        _ => Ok(()),
    }
}

fn new_sync_epoch() -> ClusterResult<String> {
    let mut bytes = [0u8; SYNC_EPOCH_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| {
        ClusterError::new(
            codes::INTERNAL_ERROR,
            format!("The node could not read random bytes for an index epoch: {error}"),
        )
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn feature_on(settings: &Map, feature: &str) -> bool {
    matches!(settings.get(feature), Some(Value::Object(fields)) if fields.get("enabled") == Some(&Value::Bool(true)))
        && matches!(settings.get("syncEpoch"), Some(Value::String(_)))
}

fn history_setting(
    enabled_fields: &[(&str, Value)],
    age: Option<u64>,
    bytes: Option<u64>,
) -> Value {
    let mut setting: Map = enabled_fields
        .iter()
        .map(|(key, value)| (*key, value.clone()))
        .collect();
    if let Some(age) = age {
        setting.insert("historyMaxAgeMs", Value::Number(age as f64));
    }
    if let Some(bytes) = bytes {
        setting.insert("historyMaxBytes", Value::Number(bytes as f64));
    }
    Value::Object(setting)
}

fn stored_sync_setting(setting: &SyncSetting) -> Value {
    history_setting(
        &[("enabled", Value::Bool(true))],
        setting.history_max_age_ms,
        setting.history_max_bytes,
    )
}

fn stored_changes_setting(setting: &ChangesSetting) -> Value {
    let mut fields = vec![("enabled", Value::Bool(true))];
    if setting.previous_document {
        fields.push(("previousDocument", Value::Bool(true)));
    }
    history_setting(
        &fields,
        setting.history_max_age_ms,
        setting.history_max_bytes,
    )
}

fn sync_fields_of(settings: &Map) -> Map {
    SYNC_FIELDS
        .iter()
        .filter_map(|field| Some((*field, settings.get(field)?.clone())))
        .collect()
}

pub(super) fn next_sync_settings(
    current: &Map,
    setting: &SyncSetting,
) -> ClusterResult<Option<Map>> {
    let was_on = feature_on(current, "sync");
    let mut capture: Option<Map> = None;
    if feature_on(current, "changes") {
        let mut kept = Map::new();
        for field in ["changes", "syncEpoch"] {
            if let Some(value) = current.get(field) {
                kept.insert(field, value.clone());
            }
        }
        capture = Some(kept);
    }
    if !setting.enabled {
        if !was_on && current.get("sync").is_none() {
            return Ok(None);
        }
        return Ok(Some(capture.unwrap_or_default()));
    }
    if !was_on {
        let mut next = capture.unwrap_or_default();
        next.insert("sync", stored_sync_setting(setting));
        next.insert("syncActive", Value::Bool(false));
        if next.get("syncEpoch").is_none() {
            next.insert("syncEpoch", Value::String(new_sync_epoch()?));
        }
        return Ok(Some(next));
    }
    let mut next = sync_fields_of(current);
    next.insert("sync", stored_sync_setting(setting));
    Ok(Some(next))
}

pub(super) fn next_changes_settings(
    current: &Map,
    setting: &ChangesSetting,
) -> ClusterResult<Option<Map>> {
    let mut others = sync_fields_of(current);
    others.remove("changes");
    let sync_on = feature_on(current, "sync");
    let changes_on = feature_on(current, "changes");
    if !setting.enabled {
        if current.get("changes").is_none() {
            return Ok(None);
        }
        return Ok(Some(if sync_on { others } else { Map::new() }));
    }
    others.insert("changes", stored_changes_setting(setting));
    if !sync_on && !changes_on {
        others.insert("syncActive", Value::Bool(false));
        others.insert("syncEpoch", Value::String(new_sync_epoch()?));
    }
    Ok(Some(others))
}

pub(super) fn require_sync_on(index_name: &str, current: &Map) -> ClusterResult<()> {
    if feature_on(current, "sync") {
        return Ok(());
    }
    Err(ClusterError::new(
        codes::SYNC_NOT_ENABLED,
        format!("Index '{index_name}' has device sync off"),
    )
    .with_detail("indexName", Value::from(index_name)))
}

pub(super) fn next_active_settings(current: &Map) -> Option<Map> {
    if current.get("syncActive") == Some(&Value::Bool(true)) {
        return None;
    }
    let mut next = sync_fields_of(current);
    next.insert("syncActive", Value::Bool(true));
    Some(next)
}

fn whole(fields: &Map, key: &str) -> Option<u64> {
    match fields.get(key) {
        Some(Value::Number(number)) if number.fract() == 0.0 && *number >= 1.0 => {
            Some(*number as u64)
        }
        _ => None,
    }
}

fn epoch_of(settings: &Map) -> Option<String> {
    settings
        .get("syncEpoch")
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(super) fn sync_status_of(settings: &Map) -> SyncStatus {
    if !feature_on(settings, "sync") {
        return SyncStatus::default();
    }
    let Some(Value::Object(sync)) = settings.get("sync") else {
        return SyncStatus::default();
    };
    SyncStatus {
        enabled: true,
        history_max_age_ms: whole(sync, "historyMaxAgeMs"),
        history_max_bytes: whole(sync, "historyMaxBytes"),
        active: settings.get("syncActive") == Some(&Value::Bool(true)),
        epoch: epoch_of(settings),
    }
}

pub(super) fn changes_status_of(settings: &Map) -> ChangesStatus {
    if !feature_on(settings, "changes") {
        return ChangesStatus::default();
    }
    let Some(Value::Object(changes)) = settings.get("changes") else {
        return ChangesStatus::default();
    };
    ChangesStatus {
        enabled: true,
        previous_document: changes.get("previousDocument") == Some(&Value::Bool(true)),
        history_max_age_ms: whole(changes, "historyMaxAgeMs"),
        history_max_bytes: whole(changes, "historyMaxBytes"),
        epoch: epoch_of(settings),
    }
}
