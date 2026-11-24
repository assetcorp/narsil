use narsil::suggestions_host::SuggestionState;
use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use super::metadata::{IndexMetadata, metadata_key, validate_index_name, validate_record};
use super::settings::stored_settings_readable;
use crate::constants::SYNC_EPOCH_HEX_DIGITS;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};

const SETTINGS_FIELD: &str = "settings";
const PENDING_ANALYSIS_FIELD: &str = "pendingAnalysis";
const ANALYSIS_FAILURE_FIELD: &str = "analysisFailure";
const ANALYSIS_GENERATION_FIELD: &str = "analysisGeneration";
const NAMED_ANALYSIS_FIELDS: [&str; 3] = ["tokenizer", "stopWords", "stopWordList"];
const DEFAULT_LANGUAGE: &str = "english";
const BM25_FIELD: &str = "bm25";
const BM25_REVISION_FIELD: &str = "bm25Revision";
const SYNONYMS_FIELD: &str = "synonyms";

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PendingAnalysis {
    pub(crate) change_id: String,
    pub(crate) generation: f64,
    pub(crate) language: String,
    pub(crate) tokenizer: Option<String>,
    pub(crate) stop_words: Option<String>,
    pub(crate) stop_word_list: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AnalysisFailure {
    pub(crate) change_id: String,
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) node_id: String,
}

pub(crate) struct IndexMetadataSnapshot {
    pub(crate) bytes: Vec<u8>,
    pub(crate) record: IndexMetadata,
    pub(crate) settings: Option<Map>,
}

fn text_of(fields: &Map, key: &str) -> Option<String> {
    fields.get(key).and_then(Value::as_str).map(str::to_string)
}

fn pending_of(raw: &Value) -> Option<PendingAnalysis> {
    let Value::Object(pending) = raw else {
        return None;
    };
    let generation = match pending.get("generation") {
        Some(Value::Number(generation)) => *generation,
        _ => return None,
    };
    let stop_word_list = match pending.get("stopWordList") {
        Some(Value::Array(words)) => Some(
            words
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        ),
        _ => None,
    };
    Some(PendingAnalysis {
        change_id: text_of(pending, "changeId")?,
        generation,
        language: text_of(pending, "language")?,
        tokenizer: text_of(pending, "tokenizer"),
        stop_words: text_of(pending, "stopWords"),
        stop_word_list,
    })
}

pub(crate) fn pending_to_value(pending: &PendingAnalysis) -> Value {
    let mut fields = Map::with_capacity(6);
    fields.insert("changeId", Value::String(pending.change_id.clone()));
    fields.insert("generation", Value::Number(pending.generation));
    fields.insert("language", Value::String(pending.language.clone()));
    if let Some(tokenizer) = &pending.tokenizer {
        fields.insert("tokenizer", Value::String(tokenizer.clone()));
    }
    if let Some(stop_words) = &pending.stop_words {
        fields.insert("stopWords", Value::String(stop_words.clone()));
    }
    if let Some(words) = &pending.stop_word_list {
        fields.insert(
            "stopWordList",
            Value::Array(words.iter().cloned().map(Value::String).collect()),
        );
    }
    Value::Object(fields)
}

fn failure_to_value(failure: &AnalysisFailure) -> Value {
    let mut fields = Map::with_capacity(4);
    fields.insert("changeId", Value::String(failure.change_id.clone()));
    fields.insert("code", Value::String(failure.code.clone()));
    fields.insert("message", Value::String(failure.message.clone()));
    fields.insert("nodeId", Value::String(failure.node_id.clone()));
    Value::Object(fields)
}

fn settings_invalid(index_name: &str) -> ClusterError {
    ClusterError::new(
        codes::CONTROLLER_METADATA_INVALID,
        format!("Index metadata for '{index_name}' has invalid settings"),
    )
    .with_detail("indexName", Value::String(index_name.to_string()))
}

pub(crate) fn index_metadata_snapshot_of(
    bytes: Vec<u8>,
    index_name: &str,
) -> ClusterResult<IndexMetadataSnapshot> {
    let decoded = decode_msgpack(&bytes).map_err(ClusterError::from)?;
    let record = validate_record(&decoded, index_name)?;
    let settings = match decoded {
        Value::Object(mut fields) => match fields.remove(SETTINGS_FIELD) {
            None | Some(Value::Null) => None,
            Some(Value::Object(settings)) if stored_settings_readable(&settings) => Some(settings),
            Some(_) => return Err(settings_invalid(index_name)),
        },
        _ => None,
    };
    Ok(IndexMetadataSnapshot {
        bytes,
        record,
        settings,
    })
}

pub(crate) async fn read_index_metadata_snapshot(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<Option<IndexMetadataSnapshot>> {
    validate_index_name(index_name)?;
    match coordinator.get(&metadata_key(index_name)).await? {
        Some(bytes) if !bytes.is_empty() => index_metadata_snapshot_of(bytes, index_name).map(Some),
        _ => Ok(None),
    }
}

impl IndexMetadataSnapshot {
    pub(crate) fn pending_analysis(&self) -> Option<PendingAnalysis> {
        self.settings
            .as_ref()
            .and_then(|settings| settings.get(PENDING_ANALYSIS_FIELD))
            .and_then(pending_of)
    }

    pub(crate) fn analysis_failure(&self) -> Option<AnalysisFailure> {
        let Some(Value::Object(failure)) = self
            .settings
            .as_ref()
            .and_then(|settings| settings.get(ANALYSIS_FAILURE_FIELD))
        else {
            return None;
        };
        Some(AnalysisFailure {
            change_id: text_of(failure, "changeId")?,
            code: text_of(failure, "code")?,
            message: text_of(failure, "message")?,
            node_id: text_of(failure, "nodeId")?,
        })
    }

    pub(crate) fn published_analysis(&self) -> PendingAnalysis {
        let settings = self.settings.clone().unwrap_or_default();
        let generation = match settings.get(ANALYSIS_GENERATION_FIELD) {
            Some(Value::Number(generation)) => *generation,
            _ => 0.0,
        };
        let mut named = settings;
        named.insert("changeId", Value::String(String::new()));
        named.insert("generation", Value::Number(generation));
        if !matches!(named.get("language"), Some(Value::String(_))) {
            named.insert("language", Value::String(DEFAULT_LANGUAGE.to_string()));
        }
        pending_of(&Value::Object(named)).unwrap_or(PendingAnalysis {
            change_id: String::new(),
            generation,
            language: DEFAULT_LANGUAGE.to_string(),
            tokenizer: None,
            stop_words: None,
            stop_word_list: None,
        })
    }

    fn fields(&self) -> (Map, Map) {
        let fields = match decode_msgpack(&self.bytes) {
            Ok(Value::Object(fields)) => fields,
            _ => Map::new(),
        };
        let settings = match fields.get(SETTINGS_FIELD) {
            Some(Value::Object(settings)) => settings.clone(),
            _ => {
                let mut settings = Map::new();
                if let Some(language) = self
                    .settings
                    .as_ref()
                    .and_then(|settings| settings.get("language"))
                {
                    settings.insert("language", language.clone());
                }
                settings
            }
        };
        (fields, settings)
    }
}

fn encoded(mut fields: Map, settings: Map) -> ClusterResult<Vec<u8>> {
    fields.insert(SETTINGS_FIELD, Value::Object(settings));
    encode_msgpack(&Value::Object(fields)).map_err(ClusterError::from)
}

fn new_sync_epoch() -> ClusterResult<String> {
    let mut bytes = [0u8; SYNC_EPOCH_HEX_DIGITS / 2];
    getrandom::fill(&mut bytes).map_err(|error| {
        ClusterError::new(
            codes::INTERNAL_ERROR,
            format!("The controller could not read random bytes for a sync epoch: {error}"),
        )
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn history_enabled(settings: &Map, key: &str) -> bool {
    matches!(
        settings.get(key),
        Some(Value::Object(history)) if matches!(history.get("enabled"), Some(Value::Bool(true)))
    )
}

pub(crate) fn metadata_with_pending_analysis(
    snapshot: &IndexMetadataSnapshot,
    pending: &PendingAnalysis,
) -> ClusterResult<Vec<u8>> {
    let (fields, mut settings) = snapshot.fields();
    settings.insert(PENDING_ANALYSIS_FIELD, pending_to_value(pending));
    encoded(fields, settings)
}

pub(crate) fn metadata_without_pending_analysis(
    snapshot: &IndexMetadataSnapshot,
) -> ClusterResult<Vec<u8>> {
    let (fields, mut settings) = snapshot.fields();
    settings.remove(PENDING_ANALYSIS_FIELD);
    encoded(fields, settings)
}

pub(crate) fn metadata_publishing_analysis(
    snapshot: &IndexMetadataSnapshot,
    pending: &PendingAnalysis,
) -> ClusterResult<Vec<u8>> {
    let (fields, mut settings) = snapshot.fields();
    settings.remove(PENDING_ANALYSIS_FIELD);
    settings.remove(ANALYSIS_FAILURE_FIELD);
    for field in NAMED_ANALYSIS_FIELDS {
        settings.remove(field);
    }
    let Value::Object(named) = pending_to_value(pending) else {
        return encoded(fields, settings);
    };
    settings.insert("language", Value::String(pending.language.clone()));
    settings.insert(ANALYSIS_GENERATION_FIELD, Value::Number(pending.generation));
    for field in NAMED_ANALYSIS_FIELDS {
        if let Some(value) = named.get(field) {
            settings.insert(field, value.clone());
        }
    }
    if history_enabled(&settings, "sync") || history_enabled(&settings, "changes") {
        settings.insert("syncActive", Value::Bool(false));
        settings.insert("syncEpoch", Value::String(new_sync_epoch()?));
    }
    encoded(fields, settings)
}

pub(crate) fn metadata_with_analysis_failure(
    snapshot: &IndexMetadataSnapshot,
    failure: &AnalysisFailure,
) -> ClusterResult<Vec<u8>> {
    let (fields, mut settings) = snapshot.fields();
    settings.remove(PENDING_ANALYSIS_FIELD);
    settings.insert(ANALYSIS_FAILURE_FIELD, failure_to_value(failure));
    encoded(fields, settings)
}

fn fields_with_language(snapshot: &IndexMetadataSnapshot) -> (Map, Map) {
    let (fields, mut settings) = snapshot.fields();
    if !matches!(fields.get(SETTINGS_FIELD), Some(Value::Object(_)))
        && !settings.contains_key("language")
    {
        settings.insert("language", Value::String(DEFAULT_LANGUAGE.to_string()));
    }
    (fields, settings)
}

pub(crate) fn metadata_with_suggestion_state(
    snapshot: &IndexMetadataSnapshot,
    state: &SuggestionState,
) -> ClusterResult<Vec<u8>> {
    let (fields, mut settings) = fields_with_language(snapshot);
    state.write_settings(&mut settings);
    encoded(fields, settings)
}

pub(crate) fn metadata_with_bm25(
    snapshot: &IndexMetadataSnapshot,
    bm25: Option<Map>,
    revision: f64,
) -> ClusterResult<Vec<u8>> {
    let (fields, mut settings) = fields_with_language(snapshot);
    settings.remove(BM25_FIELD);
    settings.insert(BM25_REVISION_FIELD, Value::Number(revision));
    if let Some(bm25) = bm25 {
        settings.insert(BM25_FIELD, Value::Object(bm25));
    }
    encoded(fields, settings)
}

pub(crate) fn metadata_with_synonym_set(
    snapshot: &IndexMetadataSnapshot,
    reference: Option<Value>,
) -> ClusterResult<Vec<u8>> {
    let (fields, mut settings) = fields_with_language(snapshot);
    settings.remove(SYNONYMS_FIELD);
    if let Some(reference) = reference {
        settings.insert(SYNONYMS_FIELD, reference);
    }
    encoded(fields, settings)
}

impl IndexMetadataSnapshot {
    pub(crate) fn bm25_revision(&self) -> f64 {
        match self
            .settings
            .as_ref()
            .and_then(|settings| settings.get(BM25_REVISION_FIELD))
        {
            Some(Value::Number(revision)) if revision.is_finite() => *revision,
            _ => 0.0,
        }
    }

    pub(crate) fn synonym_set(&self) -> Option<&Value> {
        self.settings
            .as_ref()
            .and_then(|settings| settings.get(SYNONYMS_FIELD))
            .filter(|reference| !matches!(reference, Value::Null))
    }
}
