use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use crate::constants::{
    HIDDEN_GENERATION_PREFIX, INDEX_METADATA_KEY_PREFIX, MAX_SAFE_INTEGER,
    REBALANCE_RECORD_KEY_SUFFIX, RESHARD_RECORD_CAS_ATTEMPTS,
};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RebalancePhase {
    Copying,
    Cutover,
    Aborting,
}

impl RebalancePhase {
    fn of(text: &str) -> Option<RebalancePhase> {
        match text {
            "copying" => Some(RebalancePhase::Copying),
            "cutover" => Some(RebalancePhase::Cutover),
            "aborting" => Some(RebalancePhase::Aborting),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            RebalancePhase::Copying => "copying",
            RebalancePhase::Cutover => "cutover",
            RebalancePhase::Aborting => "aborting",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RebalanceRecord {
    pub(crate) job_id: String,
    pub(crate) source_generation: String,
    pub(crate) target_generation: String,
    pub(crate) target_partition_count: u64,
    pub(crate) phase: RebalancePhase,
    pub(crate) cutover_attempts: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RebalanceProgress {
    pub(crate) job_id: String,
    pub(crate) primary_term: u64,
    pub(crate) snapshot_seq_no: u64,
    pub(crate) forwarded_seq_no: u64,
    pub(crate) source_last_seq_no: u64,
}

pub(crate) fn rebalance_record_key(index_name: &str) -> String {
    format!("{INDEX_METADATA_KEY_PREFIX}{index_name}{REBALANCE_RECORD_KEY_SUFFIX}")
}

pub(crate) fn rebalance_progress_key(index_name: &str, partition_id: u32) -> String {
    format!("{}/{partition_id}", rebalance_record_key(index_name))
}

pub(crate) fn generation_name_of(index_uuid: &str) -> String {
    format!("{HIDDEN_GENERATION_PREFIX}{index_uuid}")
}

pub(crate) fn is_hidden_generation(index_name: &str) -> bool {
    index_name.starts_with(HIDDEN_GENERATION_PREFIX)
}

fn malformed(key: &str) -> ClusterError {
    ClusterError::new(
        codes::CONTROLLER_METADATA_INVALID,
        format!("The value stored under '{key}' is malformed"),
    )
    .with_detail("key", Value::from(key))
}

fn count(record: &Map, field: &str) -> Option<u64> {
    match record.get(field) {
        Some(Value::Number(number))
            if number.fract() == 0.0 && *number >= 0.0 && *number <= MAX_SAFE_INTEGER as f64 =>
        {
            Some(*number as u64)
        }
        _ => None,
    }
}

fn text(record: &Map, field: &str) -> Option<String> {
    record
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn decoded_map(key: &str, bytes: &[u8]) -> ClusterResult<Map> {
    match decode_msgpack(bytes) {
        Ok(Value::Object(record)) => Ok(record),
        _ => Err(malformed(key)),
    }
}

fn decode_record(key: &str, bytes: &[u8]) -> ClusterResult<RebalanceRecord> {
    let record = decoded_map(key, bytes)?;
    let decoded = (|| {
        Some(RebalanceRecord {
            job_id: text(&record, "jobId")?,
            source_generation: text(&record, "sourceGeneration")?,
            target_generation: text(&record, "targetGeneration")?,
            target_partition_count: count(&record, "targetPartitionCount")?,
            phase: RebalancePhase::of(record.get("phase")?.as_str()?)?,
            cutover_attempts: count(&record, "cutoverAttempts")?,
        })
    })();
    decoded.ok_or_else(|| malformed(key))
}

fn decode_progress(key: &str, bytes: &[u8]) -> ClusterResult<RebalanceProgress> {
    let progress = decoded_map(key, bytes)?;
    let decoded = (|| {
        Some(RebalanceProgress {
            job_id: text(&progress, "jobId")?,
            primary_term: count(&progress, "primaryTerm")?,
            snapshot_seq_no: count(&progress, "snapshotSeqNo")?,
            forwarded_seq_no: count(&progress, "forwardedSeqNo")?,
            source_last_seq_no: count(&progress, "sourceLastSeqNo")?,
        })
    })();
    decoded.ok_or_else(|| malformed(key))
}

fn encode_record(record: &RebalanceRecord) -> ClusterResult<Vec<u8>> {
    let mut fields = Map::with_capacity(6);
    fields.insert("jobId", Value::from(record.job_id.as_str()));
    fields.insert(
        "sourceGeneration",
        Value::from(record.source_generation.as_str()),
    );
    fields.insert(
        "targetGeneration",
        Value::from(record.target_generation.as_str()),
    );
    fields.insert(
        "targetPartitionCount",
        Value::Number(record.target_partition_count as f64),
    );
    fields.insert("phase", Value::from(record.phase.as_str()));
    fields.insert(
        "cutoverAttempts",
        Value::Number(record.cutover_attempts as f64),
    );
    Ok(encode_msgpack(&Value::Object(fields))?)
}

fn encode_progress(progress: &RebalanceProgress) -> ClusterResult<Vec<u8>> {
    let mut fields = Map::with_capacity(5);
    fields.insert("jobId", Value::from(progress.job_id.as_str()));
    fields.insert("primaryTerm", Value::Number(progress.primary_term as f64));
    fields.insert(
        "snapshotSeqNo",
        Value::Number(progress.snapshot_seq_no as f64),
    );
    fields.insert(
        "forwardedSeqNo",
        Value::Number(progress.forwarded_seq_no as f64),
    );
    fields.insert(
        "sourceLastSeqNo",
        Value::Number(progress.source_last_seq_no as f64),
    );
    Ok(encode_msgpack(&Value::Object(fields))?)
}

struct Stored<T> {
    value: Option<T>,
    bytes: Option<Vec<u8>>,
}

async fn read_stored<T>(
    coordinator: &EtcdCoordinator,
    key: &str,
    decode_value: fn(&str, &[u8]) -> ClusterResult<T>,
) -> ClusterResult<Stored<T>> {
    let bytes = coordinator.get(key).await?;
    let value = match bytes.as_deref() {
        None | Some([]) => None,
        Some(held) => Some(decode_value(key, held)?),
    };
    Ok(Stored { value, bytes })
}

pub(crate) async fn read_rebalance_record(
    coordinator: &EtcdCoordinator,
    index_name: &str,
) -> ClusterResult<Option<RebalanceRecord>> {
    let key = rebalance_record_key(index_name);
    Ok(read_stored(coordinator, &key, decode_record).await?.value)
}

pub(crate) async fn create_rebalance_record(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    record: &RebalanceRecord,
) -> ClusterResult<bool> {
    let key = rebalance_record_key(index_name);
    let stored = read_stored(coordinator, &key, decode_record).await?;
    if stored.value.is_some() {
        return Ok(false);
    }
    coordinator
        .compare_and_set(&key, stored.bytes.as_deref(), &encode_record(record)?)
        .await
}

pub(crate) async fn update_rebalance_record<F>(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    job_id: &str,
    change: F,
) -> ClusterResult<Option<RebalanceRecord>>
where
    F: Fn(&RebalanceRecord) -> Option<RebalanceRecord>,
{
    let key = rebalance_record_key(index_name);
    for _ in 0..RESHARD_RECORD_CAS_ATTEMPTS {
        let stored = read_stored(coordinator, &key, decode_record).await?;
        let Some(current) = stored.value.filter(|current| current.job_id == job_id) else {
            return Ok(None);
        };
        let next = change(&current);
        let written = match &next {
            Some(next) => encode_record(next)?,
            None => Vec::new(),
        };
        if coordinator
            .compare_and_set(&key, stored.bytes.as_deref(), &written)
            .await?
        {
            return Ok(next);
        }
    }
    Err(ClusterError::new(
        codes::ALLOCATION_FAILED,
        format!(
            "The partition count change of index '{index_name}' lost {RESHARD_RECORD_CAS_ATTEMPTS} compare-and-set attempts"
        ),
    )
    .with_detail("indexName", Value::from(index_name))
    .with_detail("jobId", Value::from(job_id)))
}

pub(crate) async fn read_rebalance_progress(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    partition_id: u32,
) -> ClusterResult<Option<RebalanceProgress>> {
    let key = rebalance_progress_key(index_name, partition_id);
    Ok(read_stored(coordinator, &key, decode_progress).await?.value)
}

pub(crate) async fn write_rebalance_progress(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    partition_id: u32,
    progress: &RebalanceProgress,
) -> ClusterResult<bool> {
    let key = rebalance_progress_key(index_name, partition_id);
    let written = encode_progress(progress)?;
    for _ in 0..RESHARD_RECORD_CAS_ATTEMPTS {
        let stored = read_stored(coordinator, &key, decode_progress).await?;
        let newer_term_holds = stored.value.as_ref().is_some_and(|held| {
            held.job_id == progress.job_id && held.primary_term > progress.primary_term
        });
        if newer_term_holds {
            return Ok(false);
        }
        if coordinator
            .compare_and_set(&key, stored.bytes.as_deref(), &written)
            .await?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) async fn clear_rebalance_progress(
    coordinator: &EtcdCoordinator,
    index_name: &str,
    partition_id: u32,
) -> ClusterResult<()> {
    let key = rebalance_progress_key(index_name, partition_id);
    for _ in 0..RESHARD_RECORD_CAS_ATTEMPTS {
        let Some(bytes) = coordinator
            .get(&key)
            .await?
            .filter(|bytes| !bytes.is_empty())
        else {
            return Ok(());
        };
        if coordinator.compare_and_set(&key, Some(&bytes), &[]).await? {
            return Ok(());
        }
    }
    Ok(())
}
