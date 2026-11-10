use crate::error::{ErrorCode, NarsilError, Result};
use crate::util::hash::{base36, fnv1a};

const SEGMENT_ID_WIDTH: usize = 16;
pub(crate) const SEGMENTS_MARKER: &str = "/segments/";

pub(crate) fn manifest_key(index_name: &str) -> String {
    format!("{index_name}/manifest")
}

fn segment_prefix(index_name: &str, partition_id: u32) -> String {
    format!("{index_name}/segments/{partition_id}/")
}

pub(crate) fn segments_prefix(index_name: &str) -> String {
    format!("{index_name}/segments/")
}

pub(crate) fn segment_key(index_name: &str, partition_id: u32, segment_id: u64) -> String {
    format!(
        "{}s{segment_id:0width$}",
        segment_prefix(index_name, partition_id),
        width = SEGMENT_ID_WIDTH
    )
}

fn encode_field_path(field_path: &str) -> Result<String> {
    let valid = !field_path.is_empty()
        && field_path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.');
    if !valid {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_SAVE_FAILED,
            format!(
                "Vector field path \"{field_path}\" contains characters that cannot be encoded in a segment key"
            ),
        ));
    }
    Ok(format!(
        "{}-{}",
        field_path.replace('.', "_"),
        base36(fnv1a(field_path.as_bytes()))
    ))
}

pub(crate) fn vector_file_key(index_name: &str, field_path: &str, file_id: u64) -> Result<String> {
    Ok(format!(
        "{}vec-{}-f{file_id:0width$}",
        segments_prefix(index_name),
        encode_field_path(field_path)?,
        width = SEGMENT_ID_WIDTH
    ))
}

fn require_generation(generation: u64) -> Result<()> {
    if generation > 0 && generation <= 9_007_199_254_740_991 {
        return Ok(());
    }
    Err(NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!("Vector graph generation {generation} must be a positive integer"),
    ))
}

pub(crate) fn graph_part_key(
    index_name: &str,
    field_path: &str,
    generation: u64,
    part: u64,
) -> Result<String> {
    require_generation(generation)?;
    Ok(format!(
        "{}vec-{}-graph-g{generation}-p{part:0width$}",
        segments_prefix(index_name),
        encode_field_path(field_path)?,
        width = SEGMENT_ID_WIDTH
    ))
}
