use narsil::{SynonymRule, Value, decode_msgpack, synonym_rules_from_json};
use sha2::{Digest, Sha256};

use crate::constants::{
    MAX_SYNONYM_GENERATION_LENGTH, SYNONYM_CHUNK_BYTES, SYNONYM_SET_KEY_PREFIX,
};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::ClusterResult;

const MAX_STORED_BYTE_LENGTH: u64 = 0xffff_ffff;
const DIGEST_HEX_DIGITS: usize = 64;
const FIRST_PRINTABLE_CHARACTER: char = ' ';

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SynonymSetRef {
    pub(crate) generation: String,
    digest: String,
    pub(crate) chunk_count: u64,
    byte_length: u64,
}

fn is_key_segment(text: &str) -> bool {
    text.chars().all(|character| {
        character >= FIRST_PRINTABLE_CHARACTER && character != '/' && character != '\\'
    })
}

fn stored_count(value: Option<&Value>) -> Option<u64> {
    match value {
        Some(Value::Number(number))
            if number.is_finite()
                && number.fract() == 0.0
                && *number >= 0.0
                && *number <= MAX_STORED_BYTE_LENGTH as f64 =>
        {
            Some(*number as u64)
        }
        _ => None,
    }
}

fn is_digest(text: &str) -> bool {
    text.len() == DIGEST_HEX_DIGITS
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn synonym_set_ref(raw: &Value) -> Result<SynonymSetRef, &'static str> {
    let Value::Object(fields) = raw else {
        return Err("synonyms must be an object");
    };
    let generation = match fields.get("generation") {
        Some(Value::String(generation))
            if !generation.is_empty()
                && generation.encode_utf16().count() <= MAX_SYNONYM_GENERATION_LENGTH
                && is_key_segment(generation) =>
        {
            generation.clone()
        }
        _ => {
            return Err(
                "synonyms.generation must hold 1 to 128 characters, with no control character, slash, or backslash",
            );
        }
    };
    let digest = match fields.get("digest") {
        Some(Value::String(digest)) if is_digest(digest) => digest.clone(),
        _ => return Err("synonyms.digest must be a lowercase hexadecimal SHA-256"),
    };
    let byte_length = match stored_count(fields.get("byteLength")) {
        Some(length) if length > 0 => length,
        _ => return Err("synonyms.byteLength must be a positive whole number"),
    };
    let chunk_count = match stored_count(fields.get("chunkCount")) {
        Some(count) if count == byte_length.div_ceil(SYNONYM_CHUNK_BYTES) => count,
        _ => return Err("synonyms.chunkCount must match synonyms.byteLength"),
    };
    Ok(SynonymSetRef {
        generation,
        digest,
        chunk_count,
        byte_length,
    })
}

fn chunk_key(index_uuid: &str, generation: &str, chunk: u64) -> String {
    format!("{SYNONYM_SET_KEY_PREFIX}{index_uuid}/{generation}/{chunk}")
}

fn digest_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) enum StoredSet {
    Read(Vec<SynonymRule>),
    ChunkMissing,
}

pub(crate) async fn read_synonym_set_bytes(
    coordinator: &EtcdCoordinator,
    index_uuid: &str,
    reference: &SynonymSetRef,
    reject: &(dyn Fn(&str) -> crate::error::ClusterError + Sync),
) -> ClusterResult<Option<Vec<u8>>> {
    let mut encoded = Vec::new();
    for chunk in 0..reference.chunk_count {
        let key = chunk_key(index_uuid, &reference.generation, chunk);
        let Some(bytes) = coordinator.get(&key).await? else {
            return Ok(None);
        };
        if bytes.len() as u64 > reference.byte_length - encoded.len() as u64 {
            return Err(reject("the stored synonym set exceeds its byteLength"));
        }
        encoded.extend_from_slice(&bytes);
    }
    if encoded.len() as u64 != reference.byte_length {
        return Err(reject(
            "the stored synonym set falls short of its byteLength",
        ));
    }
    if digest_of(&encoded) != reference.digest {
        return Err(reject("the stored synonym set does not match its digest"));
    }
    Ok(Some(encoded))
}

pub(super) async fn read_synonym_set(
    coordinator: &EtcdCoordinator,
    index_uuid: &str,
    reference: &SynonymSetRef,
    reject: &(dyn Fn(&str) -> crate::error::ClusterError + Sync),
) -> ClusterResult<StoredSet> {
    let Some(encoded) = read_synonym_set_bytes(coordinator, index_uuid, reference, reject).await?
    else {
        return Ok(StoredSet::ChunkMissing);
    };
    let decoded = decode_msgpack(&encoded).map_err(|error| reject(error.message()))?;
    let rules = synonym_rules_from_json(&decoded).map_err(|error| reject(error.message()))?;
    Ok(StoredSet::Read(rules))
}

pub(crate) async fn copy_synonym_set(
    coordinator: &EtcdCoordinator,
    source_uuid: &str,
    target_uuid: &str,
    reference: &SynonymSetRef,
    reject: &(dyn Fn(&str) -> crate::error::ClusterError + Sync),
) -> ClusterResult<bool> {
    let Some(encoded) = read_synonym_set_bytes(coordinator, source_uuid, reference, reject).await?
    else {
        return Ok(false);
    };
    for (chunk, bytes) in encoded.chunks(SYNONYM_CHUNK_BYTES as usize).enumerate() {
        let key = chunk_key(target_uuid, &reference.generation, chunk as u64);
        coordinator.compare_and_set(&key, None, bytes).await?;
    }
    Ok(true)
}

pub(crate) async fn delete_synonym_set(
    coordinator: &EtcdCoordinator,
    index_uuid: &str,
    reference: &SynonymSetRef,
) -> ClusterResult<()> {
    for chunk in 0..reference.chunk_count {
        coordinator
            .delete(&chunk_key(index_uuid, &reference.generation, chunk))
            .await?;
    }
    Ok(())
}
