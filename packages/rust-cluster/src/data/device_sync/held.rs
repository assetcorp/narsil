use narsil::replication::CopyEpochStates;
use narsil::{Language, Map, Value, decode_msgpack, synonym_rules_from_json};

use super::state::epoch_states_of_settings;
use crate::controller::{IndexMetadata, stored_index_metadata};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::data::synonym_set::{read_synonym_set_bytes, synonym_set_ref};
use crate::error::{ClusterError, ClusterResult, codes};

const DEFAULT_LANGUAGE: &str = "english";
const COPIED_FEED_SETTINGS: [&str; 4] = ["tokenizer", "stopWords", "stopWordList", "foldMarks"];

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ServingLayout {
    pub(crate) serving_name: String,
    pub(crate) index_uuid: String,
    pub(crate) partition_count: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HeldSyncIndex {
    pub(crate) index_uuid: String,
    pub(crate) settings: Option<Map>,
    pub(crate) serving: ServingLayout,
    pub(crate) feed_settings: Map,
    pub(crate) synonyms_generation: Option<String>,
    pub(crate) states: CopyEpochStates,
}

struct StoredIndexState {
    record: IndexMetadata,
    settings: Option<Map>,
    synonyms: Option<Value>,
}

fn settings_rejection(index_name: &str, message: &str) -> ClusterError {
    ClusterError::new(
        codes::CONTROLLER_METADATA_INVALID,
        format!("Index metadata for '{index_name}' has invalid settings: {message}"),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
}

fn settings_map(settings: Option<Value>) -> Option<Map> {
    match settings {
        Some(Value::Object(settings)) => Some(settings),
        _ => None,
    }
}

fn synonyms_reference(settings: Option<&Map>) -> Option<&Value> {
    settings
        .and_then(|settings| settings.get("synonyms"))
        .filter(|raw| !matches!(raw, Value::Null))
}

async fn read_index_state(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<Option<StoredIndexState>> {
    let reject = |message: &str| settings_rejection(index_name, message);
    let mut stored = stored_index_metadata(coordinator, index_name).await?;
    while let Some((record, settings)) = stored {
        let settings = settings_map(settings);
        let Some(raw) = synonyms_reference(settings.as_ref()) else {
            return Ok(Some(StoredIndexState {
                record,
                settings,
                synonyms: None,
            }));
        };
        let reference = synonym_set_ref(raw).map_err(reject)?;
        let encoded =
            read_synonym_set_bytes(coordinator, &record.index_uuid, &reference, &reject).await?;
        if let Some(encoded) = encoded {
            let decoded = decode_msgpack(&encoded).map_err(|error| reject(error.message()))?;
            let rules =
                synonym_rules_from_json(&decoded).map_err(|error| reject(error.message()))?;
            let synonyms = (!rules.is_empty()).then_some(decoded);
            return Ok(Some(StoredIndexState {
                record,
                settings,
                synonyms,
            }));
        }
        stored = stored_index_metadata(coordinator, index_name).await?;
        if let Some((current, current_settings)) = &stored
            && current.index_uuid == record.index_uuid
            && settings_map(current_settings.clone())
                .as_ref()
                .and_then(|current| synonyms_reference(Some(current)))
                .and_then(|raw| synonym_set_ref(raw).ok())
                .is_some_and(|current| current.generation == reference.generation)
        {
            return Err(reject(&format!(
                "a chunk of synonym set {} is missing",
                reference.generation
            )));
        }
    }
    Ok(None)
}

fn analysis_revision_of(language: &str) -> Option<&'static str> {
    Language::all()
        .into_iter()
        .find(|known| known.name() == language)
        .map(|known| known.revision())
}

pub(crate) fn feed_settings_of(settings: Option<&Map>, synonyms: Option<&Value>) -> Map {
    let language = settings
        .and_then(|settings| settings.get("language"))
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_LANGUAGE)
        .to_string();
    let mut feed = Map::new();
    if let Some(revision) = analysis_revision_of(&language) {
        feed.insert("analysisRevision", Value::from(revision));
    }
    feed.insert("language", Value::String(language));
    for key in COPIED_FEED_SETTINGS {
        if let Some(value) = settings.and_then(|settings| settings.get(key)) {
            feed.insert(key, value.clone());
        }
    }
    if let Some(bm25) = settings.and_then(|settings| settings.get("bm25")) {
        feed.insert("bm25", bm25.clone());
    }
    if let Some(synonyms) = synonyms {
        feed.insert("synonyms", synonyms.clone());
    }
    feed
}

fn synonyms_generation_of(settings: Option<&Map>) -> Option<String> {
    match synonyms_reference(settings)? {
        Value::Object(reference) => reference
            .get("generation")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

pub(super) async fn read_held(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<Option<HeldSyncIndex>> {
    let Some((named, named_settings)) = stored_index_metadata(coordinator, index_name).await?
    else {
        return Ok(None);
    };
    let named_settings = settings_map(named_settings);
    let serving_name = coordinator
        .allocation(index_name)
        .await?
        .and_then(|table| table.generation)
        .unwrap_or_else(|| index_name.to_string());
    let Some(state) = read_index_state(coordinator, &serving_name).await? else {
        return Ok(None);
    };
    let serving_settings = state.settings.as_ref().or(named_settings.as_ref());
    let feed_shape = match serving_settings {
        Some(serving) if serving_name != index_name => {
            let mut shaped = serving.clone();
            shaped.remove("bm25");
            if let Some(bm25) = named_settings.as_ref().and_then(|named| named.get("bm25")) {
                shaped.insert("bm25", bm25.clone());
            }
            Some(shaped)
        }
        other => other.cloned(),
    };
    let synonyms_generation = synonyms_generation_of(serving_settings);
    let states = epoch_states_of_settings(named_settings.as_ref());
    Ok(Some(HeldSyncIndex {
        index_uuid: named.index_uuid,
        serving: ServingLayout {
            serving_name,
            index_uuid: state.record.index_uuid,
            partition_count: state.record.partition_count as u32,
        },
        feed_settings: feed_settings_of(feed_shape.as_ref(), state.synonyms.as_ref()),
        synonyms_generation,
        settings: named_settings,
        states,
    }))
}
