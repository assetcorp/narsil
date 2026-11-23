use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use narsil::replication::BackupManifest;
use tokio::sync::OnceCell;

use super::archive::{SpooledArchive, spool_backup_archive};
use crate::backups::BackupStore;
use crate::constants::DEVICE_SYNC_ARCHIVE_IDLE_MS;
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};

struct SpoolEntry {
    index_name: String,
    ready: OnceCell<Arc<SpooledArchive>>,
    last_used: Mutex<Instant>,
}

#[derive(Default)]
struct SpoolState {
    spools: HashMap<String, Arc<SpoolEntry>>,
    chosen: HashMap<String, String>,
}

pub(crate) struct SpoolCache {
    directory: Mutex<Option<PathBuf>>,
    state: Mutex<SpoolState>,
    closed: AtomicBool,
}

fn idle_and_unused(entry: &SpoolEntry) -> Option<Duration> {
    let archive = entry.ready.get()?;
    (Arc::strong_count(archive) == 1).then(|| lock(&entry.last_used).elapsed())
}

impl SpoolCache {
    pub(crate) fn new() -> SpoolCache {
        SpoolCache {
            directory: Mutex::new(None),
            state: Mutex::default(),
            closed: AtomicBool::new(false),
        }
    }

    pub(crate) fn place(&self, directory: PathBuf) {
        *lock(&self.directory) = Some(directory);
    }

    fn evict_idle(state: &mut SpoolState) {
        let SpoolState { spools, chosen } = state;
        spools.retain(|name, entry| {
            let Some(idle) = idle_and_unused(entry) else {
                return true;
            };
            let superseded = chosen.get(&entry.index_name) != Some(name);
            !superseded && idle < Duration::from_millis(DEVICE_SYNC_ARCHIVE_IDLE_MS)
        });
    }

    pub(crate) async fn acquire(
        &self,
        store: &BackupStore,
        index_name: &str,
        backup: &BackupManifest,
    ) -> ClusterResult<Arc<SpooledArchive>> {
        if self.closed.load(Ordering::Acquire) {
            return Err(ClusterError::new(
                codes::NODE_NOT_JOINED,
                "The node is shutting down, so it spools no snapshot",
            ));
        }
        let Some(directory) = lock(&self.directory).clone() else {
            return Err(ClusterError::new(
                codes::NODE_NOT_JOINED,
                "The node has not opened its snapshot spool directory, so it spools no snapshot",
            ));
        };
        let entry = {
            let mut state = lock(&self.state);
            state
                .chosen
                .insert(index_name.to_string(), backup.name.clone());
            SpoolCache::evict_idle(&mut state);
            Arc::clone(state.spools.entry(backup.name.clone()).or_insert_with(|| {
                Arc::new(SpoolEntry {
                    index_name: index_name.to_string(),
                    ready: OnceCell::new(),
                    last_used: Mutex::new(Instant::now()),
                })
            }))
        };
        let held = backup.clone();
        let spooled = entry
            .ready
            .get_or_try_init(|| async move {
                store
                    .run(move |store| spool_backup_archive(store, &held, &directory))
                    .await
                    .map(Arc::new)
            })
            .await;
        match spooled {
            Ok(archive) => {
                *lock(&entry.last_used) = Instant::now();
                Ok(Arc::clone(archive))
            }
            Err(error) => {
                let mut state = lock(&self.state);
                if state
                    .spools
                    .get(&backup.name)
                    .is_some_and(|held| Arc::ptr_eq(held, &entry))
                {
                    state.spools.remove(&backup.name);
                }
                Err(error)
            }
        }
    }

    pub(crate) fn chosen(&self, index_name: &str) -> Option<Arc<SpooledArchive>> {
        let state = lock(&self.state);
        let name = state.chosen.get(index_name)?;
        state.spools.get(name)?.ready.get().cloned()
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let mut state = lock(&self.state);
        state.spools.clear();
        state.chosen.clear();
    }
}
