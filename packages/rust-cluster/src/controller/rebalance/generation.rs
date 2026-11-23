use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use crate::allocator::{Assignments, Table};
use crate::constants::{
    HIDDEN_GENERATION_PREFIX, SYNC_EPOCH_BYTES, SYNC_EPOCH_CAS_ATTEMPTS, TEARDOWN_CAS_ATTEMPTS,
};
use crate::controller::metadata::{metadata_key, validate_record};
use crate::controller::stored_table;
use crate::coordinator::etcd::EtcdCoordinator;
use crate::data::synonym_set::{
    SynonymSetRef, copy_synonym_set, delete_synonym_set, synonym_set_ref,
};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::rebalance::{RebalanceRecord, clear_rebalance_progress};

const SYNC_FIELDS: [&str; 4] = ["sync", "syncActive", "syncEpoch", "changes"];

fn settings_rejection(index_name: &str) -> impl Fn(&str) -> ClusterError + Sync + '_ {
    move |message: &str| {
        ClusterError::new(
            codes::CONTROLLER_METADATA_INVALID,
            format!("Index metadata for '{index_name}' has invalid settings: {message}"),
        )
        .with_detail("indexName", Value::String(index_name.to_string()))
    }
}

fn decoded_metadata(bytes: &[u8]) -> Option<Map> {
    match decode_msgpack(bytes) {
        Ok(Value::Object(fields)) => Some(fields),
        _ => None,
    }
}

fn stored_synonym_set_of(bytes: &[u8]) -> Option<(String, SynonymSetRef)> {
    let fields = decoded_metadata(bytes)?;
    let index_uuid = fields.get("indexUuid")?.as_str()?.to_string();
    let Some(Value::Object(settings)) = fields.get("settings") else {
        return None;
    };
    let reference = synonym_set_ref(settings.get("synonyms")?).ok()?;
    Some((index_uuid, reference))
}

fn without_sync_fields(settings: &Map) -> Map {
    settings
        .iter()
        .filter(|(key, _)| !SYNC_FIELDS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn encoded(value: Map) -> ClusterResult<Vec<u8>> {
    encode_msgpack(&Value::Object(value)).map_err(ClusterError::from)
}

async fn put_generation_metadata(
    coordinator: &EtcdCoordinator,
    source_name: &str,
    record: &RebalanceRecord,
) -> ClusterResult<bool> {
    let key = metadata_key(&record.target_generation);
    let reject = settings_rejection(source_name);
    let target_uuid = &record.target_generation[HIDDEN_GENERATION_PREFIX.len()..];
    let mut copied_set_generation: Option<String> = None;
    loop {
        let Some(source_bytes) = coordinator.get(&metadata_key(source_name)).await? else {
            return Ok(false);
        };
        if source_bytes.is_empty() {
            return Ok(false);
        }
        let decoded = decode_msgpack(&source_bytes).map_err(ClusterError::from)?;
        validate_record(&decoded, source_name)?;
        let Value::Object(mut fields) = decoded else {
            return Ok(false);
        };
        let current = coordinator.get(&key).await?;
        if current.as_ref().is_some_and(|bytes| !bytes.is_empty()) {
            return Ok(true);
        }
        if let Some((source_uuid, reference)) = stored_synonym_set_of(&source_bytes)
            && !copy_synonym_set(coordinator, &source_uuid, target_uuid, &reference, &reject)
                .await?
        {
            if copied_set_generation.as_deref() == Some(reference.generation.as_str()) {
                return Err(reject(&format!(
                    "a chunk of synonym set {} is missing",
                    reference.generation
                )));
            }
            copied_set_generation = Some(reference.generation.clone());
            continue;
        }
        if let Some(Value::Object(settings)) = fields.get("settings") {
            let stripped = without_sync_fields(settings);
            fields.insert("settings", Value::Object(stripped));
        }
        fields.insert("indexName", Value::String(record.target_generation.clone()));
        fields.insert("indexUuid", Value::String(target_uuid.to_string()));
        fields.insert(
            "partitionCount",
            Value::Number(record.target_partition_count as f64),
        );
        return coordinator
            .compare_and_set(&key, current.as_deref(), &encoded(fields)?)
            .await;
    }
}

pub(crate) async fn ensure_generation(
    coordinator: &EtcdCoordinator,
    record: &RebalanceRecord,
) -> ClusterResult<()> {
    let lost = |what: &str| {
        ClusterError::new(
            codes::INDEX_NOT_FOUND,
            format!(
                "Index '{}' lost its {what} before its new partition layout was created",
                record.source_generation
            ),
        )
        .with_detail("indexName", Value::String(record.source_generation.clone()))
        .with_detail(
            "targetGeneration",
            Value::String(record.target_generation.clone()),
        )
    };
    if !put_generation_metadata(coordinator, &record.source_generation, record).await? {
        return Err(lost("metadata"));
    }
    if coordinator
        .schema(&record.target_generation)
        .await?
        .is_some()
    {
        return Ok(());
    }
    let Some(schema) = coordinator.schema(&record.source_generation).await? else {
        return Err(lost("schema"));
    };
    coordinator
        .put_schema(&record.target_generation, &schema)
        .await
}

fn teardown_lost(index_name: &str, message: String) -> ClusterError {
    ClusterError::new(codes::ALLOCATION_FAILED, message)
        .with_detail("indexName", Value::String(index_name.to_string()))
        .with_detail("attempts", Value::Number(TEARDOWN_CAS_ATTEMPTS as f64))
}

async fn empty_allocation(
    coordinator: &EtcdCoordinator,
    writer_node_id: &str,
    index_name: &str,
) -> ClusterResult<()> {
    for _ in 0..TEARDOWN_CAS_ATTEMPTS {
        let Some(table) = stored_table(coordinator, index_name).await? else {
            return Ok(());
        };
        if table.assignments.is_empty() {
            return Ok(());
        }
        let empty = Table {
            index_name: index_name.to_string(),
            version: table.version + 1.0,
            replication_factor: table.replication_factor,
            assignments: Assignments::default(),
            generation: None,
            index_uuid: table.index_uuid.clone(),
        };
        if coordinator
            .put_allocation_guarded(
                index_name,
                &empty.to_stored(),
                Some(table.version),
                writer_node_id,
                None,
            )
            .await?
        {
            return Ok(());
        }
    }
    Err(teardown_lost(
        index_name,
        format!(
            "Teardown of the allocation for index '{index_name}' lost every compare-and-set attempt"
        ),
    ))
}

pub(crate) async fn drop_generation(
    coordinator: &EtcdCoordinator,
    writer_node_id: &str,
    generation: &str,
) -> ClusterResult<()> {
    empty_allocation(coordinator, writer_node_id, generation).await?;
    let key = metadata_key(generation);
    if let Some(metadata) = coordinator.get(&key).await?
        && !metadata.is_empty()
        && coordinator
            .compare_and_set(&key, Some(&metadata), &[])
            .await?
        && let Some((index_uuid, reference)) = stored_synonym_set_of(&metadata)
    {
        delete_synonym_set(coordinator, &index_uuid, &reference).await?;
    }
    if coordinator.schema(generation).await?.is_some() {
        return coordinator.drop_schema(generation).await;
    }
    coordinator.delete_allocation(generation).await
}

pub(crate) async fn drop_replaced_name_synonym_set(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<()> {
    let key = metadata_key(index_name);
    for _ in 0..TEARDOWN_CAS_ATTEMPTS {
        let Some(bytes) = coordinator.get(&key).await? else {
            return Ok(());
        };
        if bytes.is_empty() {
            return Ok(());
        }
        let decoded = decode_msgpack(&bytes).map_err(ClusterError::from)?;
        let record = validate_record(&decoded, index_name)?;
        let Value::Object(mut fields) = decoded else {
            return Ok(());
        };
        let Some(Value::Object(mut settings)) = fields.remove("settings") else {
            return Ok(());
        };
        let Some(raw_reference) = settings.remove("synonyms") else {
            return Ok(());
        };
        let reference = synonym_set_ref(&raw_reference).map_err(settings_rejection(index_name))?;
        fields.insert("settings", Value::Object(settings));
        if coordinator
            .compare_and_set(&key, Some(&bytes), &encoded(fields)?)
            .await?
        {
            return delete_synonym_set(coordinator, &record.index_uuid, &reference).await;
        }
    }
    Err(teardown_lost(
        index_name,
        format!(
            "Releasing the replaced synonym set of index '{index_name}' lost every compare-and-set attempt"
        ),
    ))
}

pub(crate) async fn clear_every_progress(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    partition_count: usize,
) -> ClusterResult<()> {
    for partition_id in 0..partition_count {
        clear_rebalance_progress(coordinator, index_name, partition_id as u32).await?;
    }
    Ok(())
}

fn new_sync_epoch() -> ClusterResult<String> {
    let mut bytes = [0u8; SYNC_EPOCH_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| {
        ClusterError::new(
            codes::INTERNAL_ERROR,
            format!("The controller could not read random bytes for a sync epoch: {error}"),
        )
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn epoch_features_on(settings: &Map) -> bool {
    let enabled = |field: &str| match settings.get(field) {
        Some(Value::Object(setting)) => setting.get("enabled") == Some(&Value::Bool(true)),
        _ => false,
    };
    enabled("sync") || enabled("changes")
}

pub(crate) async fn renew_cluster_sync_epoch(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<bool> {
    let key = metadata_key(index_name);
    for _ in 0..SYNC_EPOCH_CAS_ATTEMPTS {
        let Some(bytes) = coordinator.get(&key).await? else {
            return Ok(false);
        };
        if bytes.is_empty() {
            return Ok(false);
        }
        let decoded = decode_msgpack(&bytes).map_err(ClusterError::from)?;
        validate_record(&decoded, index_name)?;
        let Value::Object(mut fields) = decoded else {
            return Ok(false);
        };
        let Some(Value::Object(mut settings)) = fields.remove("settings") else {
            return Ok(true);
        };
        if !epoch_features_on(&settings) {
            return Ok(true);
        }
        settings.insert("syncActive", Value::Bool(false));
        settings.insert("syncEpoch", Value::String(new_sync_epoch()?));
        fields.insert("settings", Value::Object(settings));
        if coordinator
            .compare_and_set(&key, Some(&bytes), &encoded(fields)?)
            .await?
        {
            return Ok(true);
        }
    }
    Ok(false)
}
