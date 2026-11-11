use super::{MANIFEST_ENVELOPE_VERSION, SEGMENT_MANIFEST_VERSION, SegmentManifest};
use crate::error::Result;
use crate::format::envelope::{Compression, pack};
use crate::format::manifest_refs::{file_ref_to_wire, vector_fields_to_wire};
use crate::value::{Map, Value, encode_value};

pub(crate) fn manifest_to_wire(manifest: &SegmentManifest) -> Map {
    let mut map = Map::new();
    map.insert("version", Value::Number(SEGMENT_MANIFEST_VERSION as f64));
    map.insert("schema", Value::Object(manifest.schema.clone()));
    map.insert("language", Value::String(manifest.language.clone()));
    if let Some(generation) = manifest
        .analysis_generation
        .filter(|generation| *generation > 0)
    {
        map.insert("analysisGeneration", Value::Number(generation as f64));
    }
    let checkpoint = manifest
        .checkpoint
        .iter()
        .map(|entry| {
            let mut wire = Map::new();
            wire.insert("partitionId", Value::Number(entry.partition_id as f64));
            wire.insert("lastSeqNo", Value::Number(entry.last_seq_no as f64));
            wire.insert("primaryTerm", Value::Number(entry.primary_term as f64));
            if let Some(history) = &entry.term_history {
                let starts = history
                    .iter()
                    .map(|start| {
                        let mut item = Map::new();
                        item.insert("primaryTerm", Value::Number(start.primary_term as f64));
                        item.insert("firstSeqNo", Value::Number(start.first_seq_no as f64));
                        Value::Object(item)
                    })
                    .collect();
                wire.insert("termHistory", Value::Array(starts));
            }
            Value::Object(wire)
        })
        .collect();
    map.insert("checkpoint", Value::Array(checkpoint));
    let partitions = manifest
        .partitions
        .iter()
        .map(|partition| {
            let mut wire = Map::new();
            wire.insert("partitionId", Value::Number(partition.partition_id as f64));
            wire.insert(
                "nextSegmentId",
                Value::Number(partition.next_segment_id as f64),
            );
            let segments = partition
                .segments
                .iter()
                .map(|segment| {
                    let mut item = Map::new();
                    item.insert("id", Value::Number(segment.id as f64));
                    item.insert("key", Value::String(segment.file.key.clone()));
                    item.insert("docCount", Value::Number(segment.document_count as f64));
                    item.insert(
                        "tombstoneCount",
                        Value::Number(segment.tombstone_count as f64),
                    );
                    item.insert("bytes", Value::Number(segment.file.bytes as f64));
                    item.insert("checksum", Value::Number(segment.file.checksum as f64));
                    if segment.file.head.is_some() {
                        file_ref_to_wire(&mut item, &segment.file);
                    }
                    Value::Object(item)
                })
                .collect();
            wire.insert("segments", Value::Array(segments));
            Value::Object(wire)
        })
        .collect();
    map.insert("partitions", Value::Array(partitions));
    map.insert("vectors", vector_fields_to_wire(&manifest.vectors));
    map
}

pub(crate) fn encode_manifest(
    manifest: &SegmentManifest,
    compression: Compression,
) -> Result<Vec<u8>> {
    let payload = encode_value(&Value::Object(manifest_to_wire(manifest)))?;
    pack(
        &payload,
        MANIFEST_ENVELOPE_VERSION,
        compression,
        "segment manifest",
    )
}
