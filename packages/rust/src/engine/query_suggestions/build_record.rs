use std::fmt::Write;

use sha2::{Digest, Sha256};

use super::constants::SOURCES_DIGEST_BYTES;
use super::types::{
    QuerySuggestionsBuild, QuerySuggestionsBuildStatus, QuerySuggestionsBuildTrigger,
};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{Compression, Expectation, open_checksummed, pack};
use crate::format::metadata_parts::non_negative_safe_integer;
use crate::value::{
    Value, decode_value, write_array_header, write_binary, write_map_header, write_string,
    write_uint,
};

const BUILD_RECORD_FORMAT_VERSION: u8 = 1;
const WHAT: &str = "query suggestions build record";
const UUID_VERSION_FOUR: u8 = 0x40;
const UUID_VARIANT: u8 = 0x80;
const SINGLE_NODE_ID: &str = "";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BuildRecord {
    pub(crate) build: QuerySuggestionsBuild,
    pub(crate) sources_digest: [u8; SOURCES_DIGEST_BYTES],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MergedSource {
    pub(crate) key: String,
    pub(crate) saved_at: u64,
}

pub(crate) fn new_build_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| {
        NarsilError::new(
            ErrorCode::INTERNAL_ERROR,
            format!("The engine could not read random bytes for a build ID: {error}"),
        )
    })?;
    bytes[6] = (bytes[6] & 0x0f) | UUID_VERSION_FOUR;
    bytes[8] = (bytes[8] & 0x3f) | UUID_VARIANT;
    let mut text = String::with_capacity(36);
    for (at, byte) in bytes.iter().enumerate() {
        if matches!(at, 4 | 6 | 8 | 10) {
            text.push('-');
        }
        let _ = write!(text, "{byte:02x}");
    }
    Ok(text)
}

pub(crate) fn sources_digest_of(sources: &[MergedSource]) -> [u8; SOURCES_DIGEST_BYTES] {
    let mut sorted: Vec<&MergedSource> = sources.iter().collect();
    sorted.sort_by(|left, right| left.key.cmp(&right.key));
    let mut encoded = Vec::new();
    write_array_header(&mut encoded, sorted.len());
    for source in sorted {
        write_array_header(&mut encoded, 3);
        write_string(&mut encoded, SINGLE_NODE_ID);
        write_string(&mut encoded, &source.key);
        write_uint(&mut encoded, source.saved_at);
    }
    Sha256::digest(&encoded).into()
}

pub(crate) fn encode_build_record(record: &BuildRecord) -> Result<Vec<u8>> {
    let build = &record.build;
    let keys = 8 + usize::from(build.ended_at.is_some()) + usize::from(build.error_code.is_some());
    let mut payload = Vec::new();
    write_map_header(&mut payload, keys);
    write_string(&mut payload, "buildId");
    write_string(&mut payload, &build.build_id);
    write_string(&mut payload, "trigger");
    write_string(&mut payload, build.trigger.as_str());
    write_string(&mut payload, "status");
    write_string(&mut payload, build.status.as_str());
    write_string(&mut payload, "startedAt");
    write_uint(&mut payload, build.started_at);
    if let Some(ended_at) = build.ended_at {
        write_string(&mut payload, "endedAt");
        write_uint(&mut payload, ended_at);
    }
    for (key, value) in [
        ("published", build.published),
        ("removed", build.removed),
        ("discarded", build.discarded),
    ] {
        write_string(&mut payload, key);
        write_uint(&mut payload, value);
    }
    write_string(&mut payload, "sourcesDigest");
    write_binary(&mut payload, &record.sources_digest);
    if let Some(code) = &build.error_code {
        write_string(&mut payload, "errorCode");
        write_string(&mut payload, code);
    }
    pack(
        &payload,
        BUILD_RECORD_FORMAT_VERSION,
        Compression::None,
        WHAT,
    )
}

pub(crate) fn decode_build_record(bytes: &[u8]) -> Option<BuildRecord> {
    let expectation = Expectation {
        version: BUILD_RECORD_FORMAT_VERSION,
        what: WHAT,
        allows_compression: false,
    };
    let (_, payload) = open_checksummed(bytes, &expectation).ok()?;
    let Value::Object(wire) = decode_value(payload.bytes()).ok()? else {
        return None;
    };
    let text = |key: &str| match wire.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    };
    let trigger = QuerySuggestionsBuildTrigger::named(&text("trigger")?)?;
    let status = QuerySuggestionsBuildStatus::named(&text("status")?)?;
    let count_of = |key: &str| non_negative_safe_integer(wire.get(key));
    let ended_at = match wire.get("endedAt") {
        None => None,
        Some(_) => Some(count_of("endedAt")?),
    };
    let error_code = match wire.get("errorCode") {
        None => None,
        Some(Value::String(code)) => Some(code.clone()),
        Some(_) => return None,
    };
    let sources_digest = match wire.get("sourcesDigest") {
        Some(Value::Bytes(digest)) => {
            <[u8; SOURCES_DIGEST_BYTES]>::try_from(digest.as_slice()).ok()?
        }
        _ => return None,
    };
    Some(BuildRecord {
        build: QuerySuggestionsBuild {
            build_id: text("buildId")?,
            trigger,
            status,
            started_at: count_of("startedAt")?,
            ended_at,
            published: count_of("published")?,
            removed: count_of("removed")?,
            discarded: count_of("discarded")?,
            error_code,
        },
        sources_digest,
    })
}
