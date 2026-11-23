use std::collections::HashSet;
use std::time::{Duration, Instant};

use super::super::constants::{BACKUP_DELETES_AT_ONCE, BACKUP_PROGRESS_REPORT_INTERVAL_MS};
use super::super::driver_context::BackupDriverContext;
use super::super::keys::is_sha256_hex;
use super::super::manifest::stored_files_of;
use super::super::store::{BackupStore, claim_backup_store, cluster_uuid_of, read_every_manifest};
use crate::error::{ClusterError, ClusterResult, codes};

fn unlisted_file_keys(store: &BackupStore) -> ClusterResult<Vec<String>> {
    let mut listed = HashSet::new();
    for manifest in read_every_manifest(store)? {
        for file in stored_files_of(&manifest) {
            listed.insert(file.sha256.clone());
        }
    }
    let files = &store.keys.files;
    Ok(store
        .list(files)?
        .into_iter()
        .filter(|key| {
            key.strip_prefix(files.as_str())
                .is_some_and(|sha256| is_sha256_hex(sha256) && !listed.contains(sha256))
        })
        .collect())
}

fn delete_batch(store: &BackupStore, batch: &[String]) -> ClusterResult<()> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = batch
            .iter()
            .map(|key| scope.spawn(move || store.delete(key)))
            .collect();
        for handle in handles {
            handle.join().unwrap_or_else(|_| {
                Err(ClusterError::new(
                    codes::INTERNAL_ERROR,
                    "A deletion of a stored backup file stopped before it finished",
                ))
            })?;
        }
        Ok(())
    })
}

pub(crate) async fn run_backup_deletion(context: BackupDriverContext) -> ClusterResult<()> {
    let cluster_uuid = cluster_uuid_of(context.coordinator()).await?;
    context
        .store
        .run(move |store| claim_backup_store(store, &cluster_uuid))
        .await?;
    context.assert_still_driving()?;
    let backup_name = context.job.backup_name.clone();
    let doomed = context
        .store
        .run(move |store| {
            store.delete(&store.keys.manifest(&backup_name)?)?;
            unlisted_file_keys(store)
        })
        .await?;
    let total = doomed.len() as u64;
    context.report_job_progress(0, total).await?;
    let interval = Duration::from_millis(BACKUP_PROGRESS_REPORT_INTERVAL_MS);
    let mut reported_at = Instant::now();
    let mut deleted = 0u64;
    for batch in doomed.chunks(BACKUP_DELETES_AT_ONCE) {
        context.assert_still_driving()?;
        let batch = batch.to_vec();
        deleted += batch.len() as u64;
        context
            .store
            .run(move |store| delete_batch(store, &batch))
            .await?;
        if deleted == total || reported_at.elapsed() >= interval {
            context.report_job_progress(deleted, total).await?;
            reported_at = Instant::now();
        }
    }
    Ok(())
}
