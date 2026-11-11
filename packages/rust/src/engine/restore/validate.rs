use crate::durability::checkpoint_store::{CheckpointStore, read_listed_payload};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::graph_part::{
    GRAPH_PART_ENVELOPE_VERSION, assemble_graph_parts, decode_graph_part,
};
use crate::format::keyword_segment::{KEYWORD_SEGMENT_ENVELOPE_VERSION, decode_keyword_segment};
use crate::format::manifest::SegmentManifest;
use crate::format::vector_file::{VECTOR_FILE_ENVELOPE_VERSION, decode_vector_file};
use crate::index::frozen::FrozenSegment;
use crate::schema::{BaseType, parse_field_type};
use crate::value::{Map, Value};

fn load_failed(message: String) -> NarsilError {
    NarsilError::new(ErrorCode::PERSISTENCE_LOAD_FAILED, message)
}

fn require_schema_of_manifest(key: &str, schema: &Map, manifest: &SegmentManifest) -> Result<()> {
    for (field, found) in schema.iter() {
        let Some(listed) = manifest.schema.get(field) else {
            continue;
        };
        if listed == found {
            continue;
        }
        return Err(load_failed(format!(
            "The segment \"{key}\" gives field \"{field}\" the type \"{}\", while the manifest gives it \"{}\"",
            found.as_str().unwrap_or_default(),
            listed.as_str().unwrap_or_default()
        )));
    }
    Ok(())
}

fn vector_dimension(manifest: &SegmentManifest, path: &str) -> Option<usize> {
    let Some(Value::String(type_name)) = manifest.schema.get(path) else {
        return None;
    };
    let field_type = parse_field_type(type_name, path).ok()?;
    (field_type.base == BaseType::Vector).then_some(field_type.dimension as usize)
}

fn require_dimension(key: &str, found: usize, expected: Option<usize>) -> Result<()> {
    if expected == Some(found) {
        return Ok(());
    }
    let shown = expected.map_or_else(|| "null".to_string(), |dimension| dimension.to_string());
    Err(load_failed(format!(
        "The vector file \"{key}\" holds vectors of {found} dimensions where the schema gives {shown}"
    )))
}

fn check_segments(store: &dyn CheckpointStore, manifest: &SegmentManifest) -> Result<()> {
    for partition in &manifest.partitions {
        for listed in &partition.segments {
            let payload = read_listed_payload(
                store,
                &listed.file,
                "segment",
                KEYWORD_SEGMENT_ENVELOPE_VERSION,
                true,
            )?;
            let segment = decode_keyword_segment(&payload)?;
            require_schema_of_manifest(&listed.file.key, &segment.schema, manifest)?;
            let frozen = FrozenSegment::new(segment);
            for ordinal in 0..frozen.capacity() {
                frozen.document(ordinal)?;
            }
        }
    }
    Ok(())
}

fn check_vectors(store: &dyn CheckpointStore, manifest: &SegmentManifest) -> Result<()> {
    for field in &manifest.vectors {
        let dimension = vector_dimension(manifest, &field.field_path);
        for file in &field.files {
            let payload = read_listed_payload(
                store,
                &file.file,
                "vector file",
                VECTOR_FILE_ENVELOPE_VERSION,
                false,
            )?;
            let decoded = decode_vector_file(&payload)?;
            if decoded.field_name != field.field_path {
                return Err(load_failed(format!(
                    "The vector file \"{}\" names field \"{}\" where the manifest lists \"{}\"",
                    file.file.key, decoded.field_name, field.field_path
                )));
            }
            require_dimension(&file.file.key, decoded.dimension, dimension)?;
        }
        let mut parts = Vec::with_capacity(field.graph_parts.len());
        for part in &field.graph_parts {
            let payload =
                read_listed_payload(store, part, "graph part", GRAPH_PART_ENVELOPE_VERSION, true)?;
            parts.push(decode_graph_part(&payload)?);
        }
        if !parts.is_empty() {
            assemble_graph_parts(parts)?;
        }
    }
    Ok(())
}

/// Reads every file that a staged checkpoint lists before the restore loads any of it: each segment with every
/// document that it stores, and each vector field's files and graph parts, refusing a vector file whose vectors
/// hold another dimension than the schema gives the field.
pub(crate) fn validate_staged_checkpoint(
    store: &dyn CheckpointStore,
    manifest: &SegmentManifest,
) -> Result<()> {
    check_segments(store, manifest)?;
    check_vectors(store, manifest)
}
