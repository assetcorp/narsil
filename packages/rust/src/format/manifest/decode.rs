use super::{
    DecodedManifest, EARLIER_SEGMENT_MANIFEST_VERSION, MAX_SEGMENTS_PER_PARTITION,
    PartitionCheckpoint, PartitionEntry, SEGMENT_MANIFEST_VERSION, SegmentManifest, SegmentRef,
    TermStart,
};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::layout::segment_key;
use crate::format::manifest_refs::{
    id_of, invalid_manifest, normalize_vector_fields, read_file_ref, sequence_of, uint32_of,
};
use crate::schema::require_valid_field_types;
use crate::value::{Map, Value};

fn normalize_term_history(raw: &Value, last_seq_no: u64) -> Result<Vec<TermStart>> {
    let Value::Array(starts) = raw else {
        return Err(invalid_manifest("has a term history that is not a list"));
    };
    let mut out: Vec<TermStart> = Vec::with_capacity(starts.len());
    for start in starts {
        let map = start.as_object();
        let (Some(primary_term), Some(first_seq_no)) = (
            map.and_then(|map| sequence_of(map.get("primaryTerm"))),
            map.and_then(|map| sequence_of(map.get("firstSeqNo"))),
        ) else {
            return Err(invalid_manifest("has an invalid term history entry"));
        };
        if first_seq_no > last_seq_no {
            return Err(invalid_manifest(format!(
                "has a term starting at seqNo {first_seq_no}, above lastSeqNo {last_seq_no}"
            )));
        }
        if out.last().is_some_and(|previous| {
            primary_term <= previous.primary_term || first_seq_no <= previous.first_seq_no
        }) {
            return Err(invalid_manifest(
                "has a term history that fails to ascend strictly",
            ));
        }
        out.push(TermStart {
            primary_term,
            first_seq_no,
        });
    }
    Ok(out)
}

pub(crate) fn normalize_checkpoint(raw: Option<&Value>) -> Result<Vec<PartitionCheckpoint>> {
    let Some(Value::Array(entries)) = raw else {
        return Err(invalid_manifest("is missing its checkpoint list"));
    };
    let mut seen: Vec<u32> = Vec::new();
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let map = entry.as_object();
        let partition_id = map.and_then(|map| uint32_of(map.get("partitionId")));
        let last_seq_no = map.and_then(|map| sequence_of(map.get("lastSeqNo")));
        let primary_term = map.and_then(|map| sequence_of(map.get("primaryTerm")));
        let (Some(map), Some(partition_id), Some(last_seq_no), Some(primary_term)) =
            (map, partition_id, last_seq_no, primary_term)
        else {
            return Err(invalid_manifest("has an invalid partition checkpoint"));
        };
        if seen.contains(&partition_id) {
            return Err(invalid_manifest("has an invalid partition checkpoint"));
        }
        seen.push(partition_id);
        let term_history = match map.get("termHistory") {
            None => None,
            Some(history) => Some(normalize_term_history(history, last_seq_no)?),
        };
        out.push(PartitionCheckpoint {
            partition_id,
            last_seq_no,
            primary_term,
            term_history,
        });
    }
    Ok(out)
}

fn normalize_segments(
    raw: Option<&Value>,
    index_name: &str,
    partition_id: u32,
) -> Result<Vec<SegmentRef>> {
    let Some(Value::Array(segments)) = raw else {
        return Err(invalid_manifest("has malformed segment references"));
    };
    if segments.len() > MAX_SEGMENTS_PER_PARTITION {
        return Err(invalid_manifest(format!(
            "lists {} segments for partition {partition_id}, above {MAX_SEGMENTS_PER_PARTITION}",
            segments.len()
        )));
    }
    let mut seen: Vec<u64> = Vec::new();
    let mut out = Vec::with_capacity(segments.len());
    for segment in segments {
        let map = segment.as_object();
        let id = map.and_then(|map| id_of(map.get("id")));
        let document_count = map.and_then(|map| uint32_of(map.get("docCount")));
        let tombstone_count = map.and_then(|map| uint32_of(map.get("tombstoneCount")));
        let (Some(map), Some(id), Some(document_count), Some(tombstone_count)) =
            (map, id, document_count, tombstone_count)
        else {
            return Err(invalid_manifest("has an invalid segment reference"));
        };
        if seen.contains(&id) {
            return Err(invalid_manifest(format!(
                "reuses segment id {id} in partition {partition_id}"
            )));
        }
        seen.push(id);
        let file = read_file_ref(map, &segment_key(index_name, partition_id, id), "segment")?;
        out.push(SegmentRef {
            id,
            file,
            document_count,
            tombstone_count,
        });
    }
    Ok(out)
}

fn normalize_partitions(raw: Option<&Value>, index_name: &str) -> Result<Vec<PartitionEntry>> {
    let Some(Value::Array(entries)) = raw else {
        return Err(invalid_manifest("is missing partition entries"));
    };
    let mut seen: Vec<u32> = Vec::new();
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let map = entry.as_object();
        let Some((map, partition_id)) =
            map.and_then(|map| uint32_of(map.get("partitionId")).map(|id| (map, id)))
        else {
            return Err(invalid_manifest("has a partition without a valid id"));
        };
        if seen.contains(&partition_id) {
            return Err(invalid_manifest("has a partition without a valid id"));
        }
        seen.push(partition_id);
        let segments = normalize_segments(map.get("segments"), index_name, partition_id)?;
        let next_segment_id = id_of(map.get("nextSegmentId"))
            .ok_or_else(|| invalid_manifest("has an invalid next segment id"))?;
        if let Some(segment) = segments
            .iter()
            .find(|segment| segment.id >= next_segment_id)
        {
            return Err(invalid_manifest(format!(
                "next segment id {next_segment_id} does not exceed segment id {}",
                segment.id
            )));
        }
        out.push(PartitionEntry {
            partition_id,
            next_segment_id,
            segments,
        });
    }
    Ok(out)
}

fn describe_version(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(value) => value.to_json(),
    }
}

pub(crate) fn decode_manifest_payload(raw: &Map, index_name: &str) -> Result<DecodedManifest> {
    let version = raw.get("version").and_then(Value::as_f64);
    if version == Some(EARLIER_SEGMENT_MANIFEST_VERSION as f64) {
        return Ok(DecodedManifest::Earlier(raw.clone()));
    }
    if version != Some(SEGMENT_MANIFEST_VERSION as f64) {
        return Err(NarsilError::new(
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            format!(
                "The segment manifest of index \"{index_name}\" holds layout {}, which this release cannot open. Export the index with the release that wrote it and import the export",
                describe_version(raw.get("version"))
            ),
        ));
    }
    let Some(Value::Object(schema)) = raw.get("schema") else {
        return Err(invalid_manifest("is missing its schema"));
    };
    require_valid_field_types(schema)?;
    let Some(Value::String(language)) = raw.get("language") else {
        return Err(invalid_manifest("is missing its language"));
    };
    let analysis_generation = match raw.get("analysisGeneration") {
        None => None,
        Some(value) => Some(
            sequence_of(Some(value))
                .ok_or_else(|| invalid_manifest("has an invalid analysis generation"))?,
        ),
    };
    Ok(DecodedManifest::Current(SegmentManifest {
        schema: schema.clone(),
        language: language.clone(),
        analysis_generation: analysis_generation.filter(|generation| *generation > 0),
        checkpoint: normalize_checkpoint(raw.get("checkpoint"))?,
        partitions: normalize_partitions(raw.get("partitions"), index_name)?,
        vectors: normalize_vector_fields(raw.get("vectors"), index_name)?,
    }))
}
