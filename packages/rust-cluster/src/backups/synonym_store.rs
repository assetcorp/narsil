use narsil::{Map, Value, encode_msgpack};

use super::files::sha256_hex;
use crate::constants::{SYNONYM_CHUNK_BYTES, SYNONYM_SET_KEY_PREFIX};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::node::generate_node_id;

pub(crate) struct StoredSynonymSet {
    pub(crate) generation: String,
    pub(crate) chunk_count: u64,
    pub(crate) reference: Value,
}

fn chunk_key(index_uuid: &str, generation: &str, chunk: u64) -> String {
    format!("{SYNONYM_SET_KEY_PREFIX}{index_uuid}/{generation}/{chunk}")
}

pub(crate) async fn delete_synonym_set(
    coordinator: &EtcdCoordinator,
    index_uuid: &str,
    set: &StoredSynonymSet,
) -> ClusterResult<()> {
    for chunk in 0..set.chunk_count {
        coordinator
            .delete(&chunk_key(index_uuid, &set.generation, chunk))
            .await?;
    }
    Ok(())
}

async fn write_chunks(
    coordinator: &EtcdCoordinator,
    index_uuid: &str,
    set: &StoredSynonymSet,
    encoded: &[u8],
) -> ClusterResult<()> {
    for (chunk, bytes) in (0u64..).zip(encoded.chunks(SYNONYM_CHUNK_BYTES as usize)) {
        let key = chunk_key(index_uuid, &set.generation, chunk);
        if !coordinator.compare_and_set(&key, None, bytes).await? {
            return Err(ClusterError::new(
                codes::CONTROLLER_METADATA_INVALID,
                format!(
                    "Synonym set chunk {chunk} of a fresh copy already exists in the coordinator"
                ),
            )
            .with_detail("indexUuid", Value::from(index_uuid))
            .with_detail("generation", Value::from(set.generation.as_str()))
            .with_detail("chunk", Value::from(chunk)));
        }
    }
    Ok(())
}

pub(crate) async fn store_synonym_set(
    coordinator: &EtcdCoordinator,
    index_uuid: &str,
    rules: &Value,
) -> ClusterResult<StoredSynonymSet> {
    let encoded = encode_msgpack(rules)?;
    let byte_length = encoded.len() as u64;
    let generation = generate_node_id()?;
    let chunk_count = byte_length.div_ceil(SYNONYM_CHUNK_BYTES);
    let mut reference = Map::with_capacity(4);
    reference.insert("generation", Value::from(generation.as_str()));
    reference.insert("digest", Value::from(sha256_hex(&encoded)));
    reference.insert("chunkCount", Value::from(chunk_count));
    reference.insert("byteLength", Value::from(byte_length));
    let set = StoredSynonymSet {
        generation,
        chunk_count,
        reference: Value::Object(reference),
    };
    if let Err(error) = write_chunks(coordinator, index_uuid, &set, &encoded).await {
        let _ = delete_synonym_set(coordinator, index_uuid, &set).await;
        return Err(error);
    }
    Ok(set)
}
