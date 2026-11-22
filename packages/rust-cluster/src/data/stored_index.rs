use narsil::{IndexConfig, Map, Value, index_config_from_stored_settings};

use super::synonym_set::{StoredSet, SynonymSetRef, read_synonym_set, synonym_set_ref};
use crate::controller::{IndexMetadata, stored_index_metadata, stored_settings_readable};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};

pub(super) struct StoredIndex {
    pub(super) index_uuid: String,
    pub(super) config: IndexConfig,
}

fn settings_invalid(index_name: &str, message: &str) -> ClusterError {
    ClusterError::new(
        codes::CONTROLLER_METADATA_INVALID,
        format!("Index metadata for '{index_name}' has invalid settings: {message}"),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
}

fn config_of(
    index_name: &str,
    schema: &Value,
    settings: Option<&Value>,
) -> ClusterResult<(IndexConfig, Option<SynonymSetRef>)> {
    let reject = |message: &str| settings_invalid(index_name, message);
    let settings: &Map = match settings {
        None | Some(Value::Null) => return Ok((IndexConfig::new(schema.clone()), None)),
        Some(Value::Object(settings)) => settings,
        Some(_) => return Err(reject("settings must be an object")),
    };
    if !stored_settings_readable(settings) {
        return Err(reject("a setting holds a value of the wrong shape"));
    }
    let config = index_config_from_stored_settings(schema.clone(), settings)
        .map_err(|error| reject(error.message()))?;
    let synonyms = match settings.get("synonyms") {
        None | Some(Value::Null) => None,
        Some(raw) => Some(synonym_set_ref(raw).map_err(reject)?),
    };
    Ok((config, synonyms))
}

fn references_same_set(
    stored: &(IndexMetadata, Option<Value>),
    index_uuid: &str,
    reference: &SynonymSetRef,
) -> bool {
    if stored.0.index_uuid != index_uuid {
        return false;
    }
    let Some(Value::Object(settings)) = &stored.1 else {
        return false;
    };
    settings
        .get("synonyms")
        .and_then(|raw| synonym_set_ref(raw).ok())
        .is_some_and(|current| current.generation == reference.generation)
}

pub(super) async fn stored_index(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    schema: &Value,
) -> ClusterResult<Option<StoredIndex>> {
    let mut stored = stored_index_metadata(coordinator, index_name).await?;
    while let Some((record, settings)) = &stored {
        let (mut config, synonyms) = config_of(index_name, schema, settings.as_ref())?;
        let index_uuid = record.index_uuid.clone();
        let Some(reference) = synonyms else {
            return Ok(Some(StoredIndex { index_uuid, config }));
        };
        let reject = |message: &str| settings_invalid(index_name, message);
        if let StoredSet::Read(rules) =
            read_synonym_set(coordinator, &index_uuid, &reference, &reject).await?
        {
            if !rules.is_empty() {
                config.synonyms = Some(rules);
            }
            return Ok(Some(StoredIndex { index_uuid, config }));
        }
        stored = stored_index_metadata(coordinator, index_name).await?;
        if let Some(current) = &stored
            && references_same_set(current, &index_uuid, &reference)
        {
            return Err(reject(&format!(
                "a chunk of synonym set {} is missing",
                reference.generation
            )));
        }
    }
    Ok(None)
}
