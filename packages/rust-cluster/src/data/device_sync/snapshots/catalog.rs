use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use narsil::BoundsFreshness;
use narsil::replication::BackupManifest;
use tokio::task::JoinHandle;

use super::super::feed_source::ClusterFeedSource;
use crate::backups::{
    BackupJobKind, BackupRequestDeps, BackupStore, CHANGES_BACKUP_TAKER, SYNC_BACKUP_TAKER,
    list_backup_names, read_backup_jobs, read_backup_manifest, request_taken_backup, sha256_hex,
};
use crate::constants::CACHED_BACKUP_MANIFEST_LIMIT;
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::node::{NodeErrorHandler, generate_node_id, report_failure};

const TAKEN_BACKUP_DIGEST_DIGITS: usize = 32;

#[derive(Default)]
struct CachedManifests {
    read: HashMap<String, Option<BackupManifest>>,
    order: VecDeque<String>,
}

pub(crate) struct BackupCatalog {
    feed: Arc<ClusterFeedSource>,
    manifests: Mutex<CachedManifests>,
    backing_up: Mutex<HashMap<String, JoinHandle<()>>>,
    closed: AtomicBool,
    on_error: Option<NodeErrorHandler>,
}

pub(crate) fn taken_backup_prefix(taken_by: &str, index_name: &str) -> String {
    let digest = sha256_hex(index_name.as_bytes());
    format!("{taken_by}-{}-", &digest[..TAKEN_BACKUP_DIGEST_DIGITS])
}

fn taker_of(name: &str) -> Option<&'static str> {
    [SYNC_BACKUP_TAKER, CHANGES_BACKUP_TAKER]
        .into_iter()
        .find(|taker| {
            let Some(rest) = name
                .strip_prefix(taker)
                .and_then(|rest| rest.strip_prefix('-'))
            else {
                return false;
            };
            rest.len() > TAKEN_BACKUP_DIGEST_DIGITS
                && rest.as_bytes()[TAKEN_BACKUP_DIGEST_DIGITS] == b'-'
                && rest.as_bytes()[..TAKEN_BACKUP_DIGEST_DIGITS]
                    .iter()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        })
}

fn may_hold_index(name: &str, index_name: &str) -> bool {
    match taker_of(name) {
        None => true,
        Some(taker) => name.starts_with(&taken_backup_prefix(taker, index_name)),
    }
}

fn qualifies(backup: &BackupManifest, oldest: &[u64]) -> bool {
    let covered: HashSet<u64> = backup
        .partitions
        .iter()
        .map(|partition| partition.partition_id)
        .collect();
    if covered.len() != oldest.len()
        || (0..oldest.len() as u64).any(|partition_id| !covered.contains(&partition_id))
    {
        return false;
    }
    backup.partitions.iter().all(|partition| {
        let floor = usize::try_from(partition.partition_id)
            .ok()
            .and_then(|position| oldest.get(position))
            .copied()
            .unwrap_or(0);
        partition.last_seq_no >= floor as f64 - 1.0
    })
}

fn copied_requests(requests: &BackupRequestDeps) -> BackupRequestDeps {
    BackupRequestDeps {
        coordinator: Arc::clone(&requests.coordinator),
        transport: Arc::clone(&requests.transport),
        node_id: requests.node_id.clone(),
        store: requests.store.clone(),
    }
}

impl BackupCatalog {
    pub(crate) fn new(
        feed: Arc<ClusterFeedSource>,
        on_error: Option<NodeErrorHandler>,
    ) -> BackupCatalog {
        BackupCatalog {
            feed,
            manifests: Mutex::default(),
            backing_up: Mutex::default(),
            closed: AtomicBool::new(false),
            on_error,
        }
    }

    async fn manifest_of(
        &self,
        store: &BackupStore,
        name: &str,
    ) -> ClusterResult<Option<BackupManifest>> {
        if let Some(read) = lock(&self.manifests).read.get(name) {
            return Ok(read.clone());
        }
        let held = name.to_string();
        let read = match store
            .run(move |store| read_backup_manifest(store, &held))
            .await
        {
            Ok(manifest) => Some(manifest),
            Err(error)
                if error.code() == codes::BACKUP_DAMAGED
                    || error.code() == codes::BACKUP_NOT_FOUND =>
            {
                None
            }
            Err(error) => return Err(error),
        };
        let mut cached = lock(&self.manifests);
        if cached.read.len() >= CACHED_BACKUP_MANIFEST_LIMIT
            && let Some(oldest) = cached.order.pop_front()
        {
            cached.read.remove(&oldest);
        }
        if cached.read.insert(name.to_string(), read.clone()).is_none() {
            cached.order.push_back(name.to_string());
        }
        Ok(read)
    }

    pub(crate) async fn matching(
        &self,
        store: &BackupStore,
        index_name: &str,
        partition_count: u32,
        epoch: &str,
    ) -> ClusterResult<Vec<BackupManifest>> {
        let names = store.run(list_backup_names).await?;
        let mut found = Vec::new();
        for name in names.iter().filter(|name| may_hold_index(name, index_name)) {
            let Some(manifest) = self.manifest_of(store, name).await? else {
                continue;
            };
            if manifest.index_name == index_name
                && manifest.sync_epoch.as_deref() == Some(epoch)
                && manifest.partition_count == u64::from(partition_count)
            {
                found.push(manifest);
            }
        }
        found.sort_by(|left, right| {
            right
                .completed_at
                .total_cmp(&left.completed_at)
                .then(right.started_at.total_cmp(&left.started_at))
        });
        Ok(found)
    }

    pub(crate) async fn qualifying(
        &self,
        store: &BackupStore,
        index_name: &str,
        partition_count: u32,
        epoch: &str,
    ) -> ClusterResult<Option<BackupManifest>> {
        let candidates = self
            .matching(store, index_name, partition_count, epoch)
            .await?;
        if candidates.is_empty() {
            return Ok(None);
        }
        let mut oldest = Vec::with_capacity(partition_count as usize);
        for partition_id in 0..partition_count {
            let bounds = self
                .feed
                .bounds(index_name, partition_id, BoundsFreshness::Recent)
                .await?;
            oldest.push(bounds.oldest_seq_no);
        }
        Ok(candidates
            .into_iter()
            .find(|backup| qualifies(backup, &oldest)))
    }

    pub(crate) async fn start_backup(
        self: &Arc<Self>,
        requests: &BackupRequestDeps,
        index_name: &str,
        taken_by: &'static str,
    ) -> ClusterResult<()> {
        let key = format!("{taken_by}\u{0}{index_name}");
        if lock(&self.backing_up).contains_key(&key) || self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        for (_, job) in read_backup_jobs(&requests.coordinator).await? {
            if job.kind == BackupJobKind::Backup
                && job.is_running()
                && job.index_name.as_deref() == Some(index_name)
            {
                return Ok(());
            }
        }
        let backup_name = format!(
            "{}{}",
            taken_backup_prefix(taken_by, index_name),
            generate_node_id()?
        );
        let mut backing_up = lock(&self.backing_up);
        if backing_up.contains_key(&key) || self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        let catalog = Arc::clone(self);
        let (deps, index, running) = (
            copied_requests(requests),
            index_name.to_string(),
            key.clone(),
        );
        let taking = tokio::spawn(async move {
            let guard = || -> ClusterResult<()> {
                if !catalog.closed.load(Ordering::Acquire) {
                    return Ok(());
                }
                Err(ClusterError::new(
                    codes::NODE_NOT_JOINED,
                    "The node is shutting down, so it stops waiting on the backup that device sync asked for",
                ))
            };
            let taken = request_taken_backup(&deps, &guard, &index, &backup_name, taken_by).await;
            if let Err(error) = taken {
                report_failure(catalog.on_error.as_ref(), &error);
            }
            lock(&catalog.backing_up).remove(&running);
        });
        backing_up.insert(key, taking);
        Ok(())
    }

    pub(crate) async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let running: Vec<JoinHandle<()>> =
            lock(&self.backing_up).drain().map(|(_, run)| run).collect();
        for run in running {
            let _ = run.await;
        }
    }
}
