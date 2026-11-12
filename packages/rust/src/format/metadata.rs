use crate::error::{Result, load_failed};
use crate::format::envelope::{Compression, Header};
use crate::format::fields::{non_negative_safe_integer, string_list};
pub(crate) use crate::format::lenient_envelope::{open_lenient_envelope, pack_lenient_envelope};
use crate::format::metadata_parts::{
    Bm25Params, ChangesSetting, EmbeddingMetadata, NamedAnalysis, PartitionLimits, PendingAnalysis,
    SyncSetting, VectorFieldMetadata, VectorPromotion, bm25_from_wire, bm25_to_wire,
    config_invalid, describe, embedding_from_wire, embedding_to_wire, feeds_from_wire,
    feeds_to_wire, limits_from_wire, limits_to_wire, named_analysis_to_wire, pending_from_wire,
    positive_integer, promotion_from_wire, promotion_to_wire, vector_fields_from_wire,
    vector_fields_to_wire,
};
use crate::value::{Map, Value, decode_value, encode_value};

pub(crate) const METADATA_ENVELOPE_VERSION: u8 = 1;
const DEFAULT_LANGUAGE: &str = "english";
const DEFAULT_ENGINE_VERSION: &str = "0.0.0";
const SCORING_MODES: [&str; 3] = ["local", "dfs", "broadcast"];

/// The settings that an index keeps in its metadata file, with the wire names of the reference writer.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct IndexMetadata {
    pub(crate) index_name: String,
    pub(crate) document_count: Option<u64>,
    pub(crate) saved_bytes: Option<u64>,
    index_uuid: Option<String>,
    held_partitions: Option<Vec<u64>>,
    pub(crate) schema: Map,
    pub(crate) language: String,
    pub(crate) partition_count: u32,
    pub(crate) bm25: Bm25Params,
    pub(crate) created_at: f64,
    pub(crate) engine_version: String,
    pub(crate) vector_fields: Option<Vec<(String, VectorFieldMetadata)>>,
    pub(crate) embedding: Option<EmbeddingMetadata>,
    pub(crate) surface_forms: Option<bool>,
    pub(crate) analysis_revision: Option<String>,
    pub(crate) array_position_gap: Option<f64>,
    pub(crate) analysis: NamedAnalysis,
    pub(crate) analysis_generation: Option<u64>,
    pub(crate) pending_analysis: Option<PendingAnalysis>,
    pub(crate) partition_limits: Option<PartitionLimits>,
    pub(crate) default_scoring: Option<String>,
    pub(crate) track_positions: Option<bool>,
    pub(crate) text_storage: Option<String>,
    pub(crate) strict: Option<bool>,
    pub(crate) required: Option<Vec<String>>,
    pub(crate) vector_promotion: Option<VectorPromotion>,
    pub(crate) pattern_value_limit: Option<u64>,
    pub(crate) synonyms: Option<Value>,
    pub(crate) sync: Option<SyncSetting>,
    pub(crate) sync_active: Option<bool>,
    pub(crate) sync_epoch: Option<String>,
    pub(crate) changes: Option<ChangesSetting>,
    pub(crate) query_suggestions: Option<Value>,
    pub(crate) banned_queries: Option<Vec<String>>,
    pub(crate) query_suggestions_source: Option<Value>,
}

impl IndexMetadata {
    pub(crate) fn new(index_name: &str, schema: Map) -> IndexMetadata {
        IndexMetadata {
            index_name: index_name.to_string(),
            document_count: None,
            saved_bytes: None,
            index_uuid: None,
            held_partitions: None,
            schema,
            language: DEFAULT_LANGUAGE.to_string(),
            partition_count: 1,
            bm25: Bm25Params::default(),
            created_at: 0.0,
            engine_version: DEFAULT_ENGINE_VERSION.to_string(),
            vector_fields: None,
            embedding: None,
            surface_forms: None,
            analysis_revision: None,
            array_position_gap: None,
            analysis: NamedAnalysis::default(),
            analysis_generation: None,
            pending_analysis: None,
            partition_limits: None,
            default_scoring: None,
            track_positions: None,
            text_storage: None,
            strict: None,
            required: None,
            vector_promotion: None,
            pattern_value_limit: None,
            synonyms: None,
            sync: None,
            sync_active: None,
            sync_epoch: None,
            changes: None,
            query_suggestions: None,
            banned_queries: None,
            query_suggestions_source: None,
        }
    }
}

fn text(map: &Map, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_string)
}

fn flag(map: &Map, key: &str) -> Option<bool> {
    map.get(key).and_then(Value::as_bool)
}

fn present(map: &Map, key: &str) -> Option<Value> {
    map.get(key).filter(|value| !value.is_null()).cloned()
}

pub(crate) fn metadata_from_wire(raw: &Map) -> Result<IndexMetadata> {
    let mut meta = IndexMetadata::new(&text(raw, "index_name").unwrap_or_default(), Map::new());
    if let Some(Value::Object(schema)) = raw.get("schema") {
        meta.schema = schema.clone();
    }
    meta.language = text(raw, "language").unwrap_or_else(|| DEFAULT_LANGUAGE.to_string());
    meta.partition_count = raw
        .get("partition_count")
        .and_then(Value::as_f64)
        .map_or(1, |count| count as u32);
    meta.bm25 = bm25_from_wire(raw.get("bm25_params"));
    meta.created_at = raw.get("created_at").and_then(Value::as_f64).unwrap_or(0.0);
    meta.engine_version =
        text(raw, "engine_version").unwrap_or_else(|| DEFAULT_ENGINE_VERSION.to_string());
    if let Some(fields) = raw.get("vector_fields").filter(|value| !value.is_null()) {
        meta.vector_fields = Some(vector_fields_from_wire(fields)?);
    }
    meta.document_count = non_negative_safe_integer(raw.get("document_count"));
    meta.saved_bytes = non_negative_safe_integer(raw.get("saved_bytes"));
    meta.embedding = embedding_from_wire(raw.get("embedding"));
    meta.surface_forms = flag(raw, "surface_forms_enabled");
    meta.analysis_revision = text(raw, "analysis_revision");
    meta.array_position_gap = raw.get("array_position_gap").and_then(Value::as_f64);
    meta.analysis = NamedAnalysis {
        tokenizer: text(raw, "tokenizer"),
        stop_words: text(raw, "stop_words"),
        stop_word_list: string_list(raw.get("stop_word_list")),
    };
    meta.analysis_generation = positive_integer(raw.get("analysis_generation"));
    meta.pending_analysis = pending_from_wire(raw.get("pending_analysis"));
    meta.partition_limits = limits_from_wire(raw.get("partition_limits"));
    meta.default_scoring =
        text(raw, "default_scoring").filter(|mode| SCORING_MODES.contains(&mode.as_str()));
    meta.track_positions = flag(raw, "track_positions");
    if let Some(storage) = raw.get("text_storage") {
        match storage.as_str() {
            Some(mode @ ("memory" | "disk")) => meta.text_storage = Some(mode.to_string()),
            _ => return Err(config_invalid("text_storage must be 'memory' or 'disk'")),
        }
    }
    meta.strict = flag(raw, "strict");
    meta.required = string_list(raw.get("required"));
    meta.vector_promotion = promotion_from_wire(raw.get("vector_promotion"))?;
    if let Some(limit) = raw.get("pattern_value_limit") {
        let Some(limit) = positive_integer(Some(limit)) else {
            return Err(config_invalid(format!(
                "The pattern value limit in the index metadata is {}, but the limit must be a whole number of code points",
                describe(limit)
            )));
        };
        meta.pattern_value_limit = Some(limit);
    }
    meta.index_uuid = text(raw, "index_uuid").filter(|uuid| !uuid.is_empty());
    if let Some(Value::Array(items)) = raw.get("held_partitions") {
        meta.held_partitions = items
            .iter()
            .map(|item| non_negative_safe_integer(Some(item)))
            .collect();
    }
    meta.synonyms = present(raw, "synonyms");
    feeds_from_wire(raw, &mut meta)?;
    meta.query_suggestions = present(raw, "query_suggestions");
    meta.banned_queries = super::metadata_bans::ban_list_of(raw.get("banned_queries"))?;
    meta.query_suggestions_source = present(raw, "query_suggestions_source");
    Ok(meta)
}

pub(crate) fn metadata_to_wire(meta: &IndexMetadata) -> Map {
    let mut wire = Map::new();
    wire.insert("index_name", Value::String(meta.index_name.clone()));
    wire.insert("schema", Value::Object(meta.schema.clone()));
    wire.insert("language", Value::String(meta.language.clone()));
    wire.insert(
        "partition_count",
        Value::Number(meta.partition_count as f64),
    );
    wire.insert("bm25_params", bm25_to_wire(&meta.bm25));
    wire.insert("created_at", Value::Number(meta.created_at));
    wire.insert("engine_version", Value::String(meta.engine_version.clone()));
    if let Some(fields) = &meta.vector_fields {
        wire.insert("vector_fields", vector_fields_to_wire(fields));
    }
    if let Some(count) = meta.document_count {
        wire.insert("document_count", Value::Number(count as f64));
    }
    if let Some(bytes) = meta.saved_bytes {
        wire.insert("saved_bytes", Value::Number(bytes as f64));
    }
    if let Some(embedding) = &meta.embedding {
        wire.insert("embedding", embedding_to_wire(embedding));
    }
    if let Some(enabled) = meta.surface_forms {
        wire.insert("surface_forms_enabled", Value::Bool(enabled));
    }
    if let Some(revision) = &meta.analysis_revision {
        wire.insert("analysis_revision", Value::String(revision.clone()));
    }
    if let Some(gap) = meta.array_position_gap {
        wire.insert("array_position_gap", Value::Number(gap));
    }
    named_analysis_to_wire(&mut wire, &meta.analysis);
    if let Some(generation) = meta.analysis_generation {
        wire.insert("analysis_generation", Value::Number(generation as f64));
    }
    if let Some(pending) = &meta.pending_analysis {
        let mut map = Map::new();
        map.insert("generation", Value::Number(pending.generation as f64));
        map.insert("language", Value::String(pending.language.clone()));
        named_analysis_to_wire(&mut map, &pending.analysis);
        wire.insert("pending_analysis", Value::Object(map));
    }
    if let Some(limits) = &meta.partition_limits {
        wire.insert("partition_limits", limits_to_wire(limits));
    }
    let optional_text = [("default_scoring", &meta.default_scoring)];
    for (key, value) in optional_text {
        if let Some(value) = value {
            wire.insert(key, Value::String(value.clone()));
        }
    }
    if let Some(track) = meta.track_positions {
        wire.insert("track_positions", Value::Bool(track));
    }
    if let Some(storage) = &meta.text_storage {
        wire.insert("text_storage", Value::String(storage.clone()));
    }
    if let Some(strict) = meta.strict {
        wire.insert("strict", Value::Bool(strict));
    }
    if let Some(required) = &meta.required {
        wire.insert(
            "required",
            Value::Array(required.iter().cloned().map(Value::String).collect()),
        );
    }
    if let Some(promotion) = &meta.vector_promotion {
        wire.insert("vector_promotion", promotion_to_wire(promotion));
    }
    if let Some(limit) = meta.pattern_value_limit {
        wire.insert("pattern_value_limit", Value::Number(limit as f64));
    }
    if let Some(uuid) = &meta.index_uuid {
        wire.insert("index_uuid", Value::String(uuid.clone()));
    }
    if let Some(held) = &meta.held_partitions {
        wire.insert(
            "held_partitions",
            Value::Array(
                held.iter()
                    .map(|partition| Value::Number(*partition as f64))
                    .collect(),
            ),
        );
    }
    if let Some(Value::Array(groups)) = &meta.synonyms
        && !groups.is_empty()
    {
        wire.insert("synonyms", Value::Array(groups.clone()));
    }
    feeds_to_wire(meta, &mut wire);
    if let Some(setting) = &meta.query_suggestions {
        wire.insert("query_suggestions", setting.clone());
    }
    if let Some(banned) = &meta.banned_queries {
        wire.insert(
            "banned_queries",
            Value::Array(banned.iter().cloned().map(Value::String).collect()),
        );
    }
    if let Some(source) = &meta.query_suggestions_source {
        wire.insert("query_suggestions_source", source.clone());
    }
    wire
}

pub(crate) fn read_metadata_file(data: &[u8]) -> Result<(Header, IndexMetadata)> {
    let (header, payload) = open_lenient_envelope(data, METADATA_ENVELOPE_VERSION)?;
    let Value::Object(raw) = decode_value(&payload)? else {
        return load_failed("The index metadata payload is not a map");
    };
    Ok((header, metadata_from_wire(&raw)?))
}

pub(crate) fn write_metadata_file(
    meta: &IndexMetadata,
    compression: Compression,
) -> Result<Vec<u8>> {
    let payload = encode_value(&Value::Object(metadata_to_wire(meta)))?;
    pack_lenient_envelope(&payload, METADATA_ENVELOPE_VERSION, compression, true)
}
