use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::metadata::open_lenient_envelope;
use crate::value::{Map, Value, decode_value, javascript_text};

use super::documents::{V2Documents, decode_v2_documents};
use super::vector_parts::{EarlierVectorPart, decode_vector_parts, vector_fields_of};

const INDEX_SNAPSHOT_ENVELOPE_VERSION: u8 = 3;
const EARLIER_SNAPSHOT_VERSION: f64 = 2.0;

/// Opens the envelope of an index snapshot that engine 0.3.0 returned, refusing any other envelope version as
/// the reference reader does, and returns its payload.
pub(crate) fn open_index_snapshot(bytes: &[u8]) -> Result<Vec<u8>> {
    let (header, payload) = open_lenient_envelope(bytes, INDEX_SNAPSHOT_ENVELOPE_VERSION)?;
    if header.envelope_format_version != INDEX_SNAPSHOT_ENVELOPE_VERSION {
        return Err(NarsilError::new(
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            format!(
                "Expected an index snapshot envelope of format v{INDEX_SNAPSHOT_ENVELOPE_VERSION}, received format v{}",
                header.envelope_format_version
            ),
        ));
    }
    Ok(payload)
}
const OLDER_SNAPSHOT_VERSION: f64 = 1.0;

/// The index snapshot that the snapshot operation of engine 0.3.0 returned, which a restore inserts as new writes.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct EarlierIndexSnapshot {
    /// Every configuration entry of the snapshot other than its schema, language, partitions, and vector
    /// indexes, such as `vectorPromotion`, `bm25`, and `analysisRevision`, as the snapshot stores them.
    pub(crate) settings: Map,
    /// The flat schema of the index.
    pub(crate) schema: Map,
    /// The name of the index's language.
    pub(crate) language: String,
    /// The stored documents of each partition, in partition order.
    pub(crate) partitions: Vec<V2Documents>,
    /// Each vector field path with its parts, in the order that the reference reader walks them.
    pub(crate) vector_indexes: Vec<(String, Vec<EarlierVectorPart>)>,
}

fn rejected(message: impl Into<String>) -> NarsilError {
    NarsilError::new(ErrorCode::DOC_VALIDATION_FAILED, message)
}

fn require_earlier_version(version: Option<&Value>) -> Result<()> {
    match version {
        Some(Value::Number(number)) if *number == EARLIER_SNAPSHOT_VERSION => Ok(()),
        Some(Value::Number(number)) if *number == OLDER_SNAPSHOT_VERSION => Err(NarsilError::new(
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            "The snapshot holds layout 1, which a release before engine 0.3.0 wrote and which this release cannot restore. Export the documents with the release that wrote it and import the export",
        )),
        other => Err(rejected(format!(
            "Unsupported snapshot version: {}. Expected version 2",
            javascript_text(other)
        ))),
    }
}

/// Reads the payload of an index snapshot that engine 0.3.0 returned, after the caller has opened its version 3
/// envelope, with the checks of the reference restore in its order.
///
/// It raises `DOC_VALIDATION_FAILED` for a payload that is not a snapshot map or that lacks a schema, a
/// language, or a list of partition payloads, `ENVELOPE_VERSION_MISMATCH` for the layout 1 snapshot of a release
/// before 0.3.0, and the errors of the partition and vector readers for a malformed partition or vector field.
/// The caller validates the schema and the settings as the configuration of the restored index.
pub(crate) fn decode_index_snapshot(payload: &[u8]) -> Result<EarlierIndexSnapshot> {
    let decoded = decode_value(payload).map_err(|error| {
        rejected(format!(
            "Snapshot data is not a Narsil snapshot: {}",
            error.message()
        ))
    })?;
    let Value::Object(mut settings) = decoded else {
        return Err(rejected("Snapshot data does not hold a snapshot envelope"));
    };
    require_earlier_version(settings.get("version"))?;
    let Some(Value::Object(schema)) = settings.remove("schema") else {
        return Err(rejected("Invalid snapshot: missing or invalid schema"));
    };
    let language = match settings.remove("language") {
        Some(Value::String(language)) if !language.is_empty() => language,
        _ => return Err(rejected("Invalid snapshot: missing or invalid language")),
    };
    let Some(Value::Array(payloads)) = settings.remove("partitions") else {
        return Err(rejected("Invalid snapshot: missing partitions"));
    };
    let payloads = payloads
        .into_iter()
        .map(|payload| match payload {
            Value::Bytes(bytes) => Ok(bytes),
            _ => Err(rejected("Invalid snapshot: missing partitions")),
        })
        .collect::<Result<Vec<_>>>()?;
    let vector_indexes =
        vector_fields_of(settings.get("vectorIndexes"), decode_vector_parts, || {
            rejected("Invalid snapshot: vectorIndexes must be a map")
        })?;
    settings.remove("vectorIndexes");
    let partitions = payloads
        .iter()
        .map(|payload| decode_v2_documents(payload))
        .collect::<Result<Vec<_>>>()?;
    Ok(EarlierIndexSnapshot {
        settings,
        schema,
        language,
        partitions,
        vector_indexes,
    })
}
