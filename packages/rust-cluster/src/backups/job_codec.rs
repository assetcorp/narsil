use narsil::{Map, Value, decode_msgpack, encode_msgpack};

use super::constants::BACKUP_JOBS_KEY;
use super::jobs::{BackupJob, BackupJobError, BackupJobKind, BackupJobStatus, BackupJobs};
use super::manifest::whole_count;
use crate::error::{ClusterError, ClusterResult, codes};

pub(super) fn malformed() -> ClusterError {
    ClusterError::new(
        codes::CONTROLLER_METADATA_INVALID,
        format!("The value stored under '{BACKUP_JOBS_KEY}' is malformed"),
    )
    .with_detail("key", Value::from(BACKUP_JOBS_KEY))
}

fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !matches!(value, Value::Null))
}

fn optional_text(fields: &Map, key: &str) -> ClusterResult<Option<String>> {
    match present(fields.get(key)) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(malformed()),
    }
}

fn decode_job_error(value: Option<&Value>) -> ClusterResult<Option<BackupJobError>> {
    let Some(value) = present(value) else {
        return Ok(None);
    };
    let fields = value.as_object().ok_or_else(malformed)?;
    match (fields.get("code"), fields.get("message")) {
        (Some(Value::String(code)), Some(Value::String(message))) => Ok(Some(BackupJobError {
            code: code.clone(),
            message: message.clone(),
        })),
        _ => Err(malformed()),
    }
}

fn decode_job(value: &Value) -> ClusterResult<BackupJob> {
    let fields = value.as_object().ok_or_else(malformed)?;
    let kind = fields
        .get("kind")
        .and_then(Value::as_str)
        .and_then(BackupJobKind::parse)
        .ok_or_else(malformed)?;
    let backup_name = fields
        .get("backupName")
        .and_then(Value::as_str)
        .ok_or_else(malformed)?;
    let status = fields
        .get("status")
        .and_then(Value::as_str)
        .and_then(BackupJobStatus::parse)
        .ok_or_else(malformed)?;
    let finished_at = match present(fields.get("finishedAt")) {
        None => None,
        found => Some(whole_count(found).ok_or_else(malformed)?),
    };
    Ok(BackupJob {
        kind,
        backup_name: backup_name.to_string(),
        index_name: optional_text(fields, "indexName")?,
        generation: optional_text(fields, "generation")?,
        name_index_uuid: optional_text(fields, "nameIndexUuid")?,
        status,
        partitions_done: whole_count(fields.get("partitionsDone")).ok_or_else(malformed)?,
        partitions_total: whole_count(fields.get("partitionsTotal")).ok_or_else(malformed)?,
        started_at: whole_count(fields.get("startedAt")).ok_or_else(malformed)?,
        finished_at,
        error: decode_job_error(fields.get("error"))?,
    })
}

fn encode_job(job: &BackupJob) -> Value {
    let mut fields = Map::with_capacity(11);
    fields.insert("kind", Value::from(job.kind.as_str()));
    fields.insert("backupName", Value::from(job.backup_name.as_str()));
    for (key, value) in [
        ("indexName", &job.index_name),
        ("generation", &job.generation),
        ("nameIndexUuid", &job.name_index_uuid),
    ] {
        if let Some(value) = value {
            fields.insert(key, Value::from(value.as_str()));
        }
    }
    fields.insert("status", Value::from(job.status.as_str()));
    fields.insert("partitionsDone", Value::Number(job.partitions_done));
    fields.insert("partitionsTotal", Value::Number(job.partitions_total));
    fields.insert("startedAt", Value::Number(job.started_at));
    if let Some(finished_at) = job.finished_at {
        fields.insert("finishedAt", Value::Number(finished_at));
    }
    if let Some(error) = &job.error {
        let mut failure = Map::with_capacity(2);
        failure.insert("code", Value::from(error.code.as_str()));
        failure.insert("message", Value::from(error.message.as_str()));
        fields.insert("error", Value::Object(failure));
    }
    Value::Object(fields)
}

pub(super) fn decode_jobs(stored: &[u8]) -> ClusterResult<BackupJobs> {
    let Ok(Value::Object(raw)) = decode_msgpack(stored) else {
        return Err(malformed());
    };
    raw.iter()
        .map(|(job_id, value)| Ok((job_id.to_string(), decode_job(value)?)))
        .collect()
}

pub(super) fn encode_jobs(jobs: &BackupJobs) -> ClusterResult<Vec<u8>> {
    if jobs.is_empty() {
        return Ok(Vec::new());
    }
    let mut map = Map::with_capacity(jobs.len());
    for (job_id, job) in jobs {
        map.insert(job_id.as_str(), encode_job(job));
    }
    Ok(encode_msgpack(&Value::Object(map))?)
}
