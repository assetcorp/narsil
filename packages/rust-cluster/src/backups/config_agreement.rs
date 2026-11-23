use narsil::replication::{
    StoredFile, decode_backup_index_configuration, encode_backup_index_configuration,
};
use narsil::{Map, Value};

use super::driver_context::BackupDriverContext;
use super::files::{load_checked_bytes, save_small_file, stored_digests};
use crate::error::{ClusterError, ClusterResult, codes};

const SUGGESTION_STATE_KEYS: [&str; 3] = [
    "querySuggestions",
    "bannedQueries",
    "querySuggestionsSource",
];

fn is_nil(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

fn same_decoded_value(left: &Value, right: &Value) -> bool {
    let mut pending: Vec<(Option<&Value>, Option<&Value>)> = vec![(Some(left), Some(right))];
    while let Some((a, b)) = pending.pop() {
        if is_nil(a) && is_nil(b) {
            continue;
        }
        let (Some(a), Some(b)) = (a, b) else {
            return false;
        };
        match (a, b) {
            (Value::Number(a), Value::Number(b)) if a.is_nan() && b.is_nan() => {}
            (Value::Array(a), Value::Array(b)) => {
                if a.len() != b.len() {
                    return false;
                }
                pending.extend(a.iter().zip(b).map(|(a, b)| (Some(a), Some(b))));
            }
            (Value::Object(a), Value::Object(b)) => {
                pending.extend(a.iter().map(|(key, value)| (Some(value), b.get(key))));
                pending.extend(
                    b.iter()
                        .filter(|(key, _)| a.get(key).is_none())
                        .map(|(_, value)| (None, Some(value))),
                );
            }
            (a, b) if a == b => {}
            _ => return false,
        }
    }
    true
}

fn settings_changed(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::ANALYSIS_CHANGE_NOT_READY,
        format!(
            "The settings of index '{index_name}' changed while its partitions were backed up, so the backup stores no manifest"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
}

fn decoded_configuration(bytes: &[u8]) -> ClusterResult<Value> {
    Ok(Value::Object(decode_backup_index_configuration(bytes)?))
}

pub(crate) async fn agreed_config_of(
    context: &BackupDriverContext,
    configs: Vec<StoredFile>,
    index_name: &str,
) -> ClusterResult<StoredFile> {
    let Some(first) = configs.first().cloned() else {
        return Err(settings_changed(index_name));
    };
    let mut distinct: Vec<StoredFile> = Vec::new();
    for config in configs {
        if config.sha256 != first.sha256
            && !distinct.iter().any(|seen| seen.sha256 == config.sha256)
        {
            distinct.push(config);
        }
    }
    if distinct.is_empty() {
        return Ok(first);
    }
    let (backup_name, index_name) = (context.job.backup_name.clone(), index_name.to_string());
    let agreed = first.clone();
    context
        .store
        .run(move |store| {
            let decoded_first =
                decoded_configuration(&load_checked_bytes(store, &first, &backup_name)?)?;
            for config in &distinct {
                let decoded =
                    decoded_configuration(&load_checked_bytes(store, config, &backup_name)?)?;
                if !same_decoded_value(&decoded_first, &decoded) {
                    return Err(settings_changed(&index_name));
                }
            }
            Ok(agreed)
        })
        .await
}

pub(crate) fn suggestion_state_of_settings(settings: Option<&Value>) -> Option<Map> {
    let fields = settings?.as_object()?;
    let mut state = Map::new();
    for key in SUGGESTION_STATE_KEYS {
        if let Some(value) = fields
            .get(key)
            .filter(|value| !matches!(value, Value::Null))
        {
            state.insert(key, value.clone());
        }
    }
    (!state.is_empty()).then_some(state)
}

pub(crate) async fn config_with_suggestion_state(
    context: &BackupDriverContext,
    config: StoredFile,
    state: Option<Map>,
) -> ClusterResult<StoredFile> {
    let Some(state) = state else {
        return Ok(config);
    };
    let backup_name = context.job.backup_name.clone();
    context
        .store
        .run(move |store| {
            let mut envelope = decode_backup_index_configuration(&load_checked_bytes(
                store,
                &config,
                &backup_name,
            )?)?;
            for (key, value) in state.iter() {
                envelope.insert(key.as_str(), value.clone());
            }
            let packed = encode_backup_index_configuration(&envelope)?;
            save_small_file(store, &packed, &mut stored_digests(store)?)
        })
        .await
}
