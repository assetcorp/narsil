use std::sync::{Arc, Mutex};

use narsil::replication::{BackupListedFile, BackupManifest, ListedFile};
use narsil::{ErrorCode, NarsilError, Value};

use super::files::load_checked_bytes;
use super::store::BackupStore;
use super::transfer_limit::TransferLimit;
use crate::controller::lock;
use crate::data::writes::{PrimaryWrites, StoredPartitionFiles};
use crate::error::{ClusterError, ClusterResult, codes};

pub(crate) struct RestoreTarget<'t> {
    pub(crate) generation: &'t str,
    pub(crate) partition_id: u32,
    pub(crate) primary_term: u64,
    pub(crate) partition_count: u64,
}

fn damaged(backup_name: &str, partition_id: u32, reason: &str) -> ClusterError {
    ClusterError::new(
        codes::BACKUP_DAMAGED,
        format!(
            "The manifest of partition {partition_id} in backup '{backup_name}' {reason}, so the restore loads nothing"
        ),
    )
    .with_detail("backupName", Value::from(backup_name))
    .with_detail("partitionId", Value::from(partition_id))
}

fn whole_seq_no(value: f64, backup_name: &str, partition_id: u32) -> ClusterResult<u64> {
    if value.fract() != 0.0 || value < 0.0 {
        return Err(damaged(
            backup_name,
            partition_id,
            "lists an invalid lastSeqNo",
        ));
    }
    Ok(value as u64)
}

fn copy_listed_file(
    store: BackupStore,
    limit: Arc<TransferLimit>,
    backup_name: String,
    files: Vec<ListedFile>,
    failure: Arc<Mutex<Option<ClusterError>>>,
) -> impl FnMut(usize, &mut dyn std::io::Write) -> narsil::Result<()> + Send {
    move |position, sink| {
        let loaded = files
            .get(position)
            .ok_or_else(|| {
                ClusterError::new(
                    codes::INTERNAL_ERROR,
                    format!("The restore lists no file at position {position}"),
                )
            })
            .and_then(|listed| {
                let _turn = limit.turn();
                load_checked_bytes(&store, &listed.file, &backup_name)
            });
        let outcome = loaded.and_then(|bytes| {
            sink.write_all(&bytes).map_err(|error| {
                ClusterError::new(
                    codes::PERSISTENCE_SAVE_FAILED,
                    format!("The restore could not pass on a backup file: {error}"),
                )
            })
        });
        outcome.map_err(|error| {
            let passed = NarsilError::new(ErrorCode::PERSISTENCE_LOAD_FAILED, error.message());
            *lock(&failure) = Some(error);
            passed
        })
    }
}

pub(crate) async fn restore_partition(
    store: &BackupStore,
    limit: &Arc<TransferLimit>,
    writes: &PrimaryWrites,
    backup: BackupManifest,
    target: &RestoreTarget<'_>,
) -> ClusterResult<()> {
    let partition_id = target.partition_id;
    let backup_name = backup.name.clone();
    let partition = match backup.partitions.get(partition_id as usize) {
        Some(partition) if backup.partition_count == target.partition_count => partition.clone(),
        _ => {
            return Err(damaged(
                &backup_name,
                partition_id,
                &format!(
                    "doesn't match the {} partitions that the restore created",
                    target.partition_count
                ),
            ));
        }
    };
    let last_seq_no = whole_seq_no(partition.last_seq_no, &backup_name, partition_id)?;
    let (manifest_file, config_file) = (partition.manifest.clone(), backup.config.clone());
    let name = backup_name.clone();
    let (manifest, config) = store
        .run(move |store| {
            let manifest = load_checked_bytes(store, &manifest_file, &name)?;
            let config = load_checked_bytes(store, &config_file, &name)?;
            Ok((manifest, config))
        })
        .await?;
    let stored = StoredPartitionFiles {
        backup_name: backup_name.clone(),
        config,
        manifest,
        files: partition
            .files
            .iter()
            .map(|listed| BackupListedFile {
                key: listed.key.clone(),
                bytes: listed.file.bytes,
            })
            .collect(),
        last_seq_no,
    };
    let failure = Arc::new(Mutex::new(None));
    let copy_file = copy_listed_file(
        store.clone(),
        Arc::clone(limit),
        backup_name,
        partition.files,
        Arc::clone(&failure),
    );
    let restored = writes
        .restore_backup_partition(
            target.generation,
            partition_id,
            target.primary_term,
            stored,
            Box::new(copy_file),
        )
        .await;
    match (restored, lock(&failure).take()) {
        (Err(_), Some(failure)) => Err(failure),
        (restored, _) => restored,
    }
}
