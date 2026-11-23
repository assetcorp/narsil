use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};

use narsil::replication::{
    BackupPartition, ListedFile, PartitionBackup, StoredFile, backup_partition_wire,
    stored_file_wire,
};
use narsil::{Map, Value};

use super::constants::{BACKUP_FILE_CHUNK_BYTES, BACKUP_FILES_AT_ONCE};
use super::files::{digest_of, save_checked_file, save_small_file, stored_digests};
use super::store::BackupStore;
use super::transfer_limit::TransferLimit;
use crate::controller::lock;
use crate::error::{ClusterError, ClusterResult, codes};

#[derive(Default)]
struct Saves {
    held: HashSet<String>,
    claimed: HashSet<String>,
    files_stored: u64,
    bytes_stored: u64,
}

struct SharedSaves {
    state: Mutex<Saves>,
    settled: Condvar,
}

enum Claim {
    Held,
    Mine,
}

impl SharedSaves {
    fn claim(&self, sha256: &str) -> Claim {
        let mut saves = lock(&self.state);
        loop {
            if saves.held.contains(sha256) {
                return Claim::Held;
            }
            if saves.claimed.insert(sha256.to_string()) {
                return Claim::Mine;
            }
            saves = self
                .settled
                .wait(saves)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    fn settle(&self, sha256: &str, saved_bytes: Option<u64>) {
        let mut saves = lock(&self.state);
        saves.claimed.remove(sha256);
        if let Some(bytes) = saved_bytes {
            saves.held.insert(sha256.to_string());
            saves.files_stored += 1;
            saves.bytes_stored += bytes;
        }
        self.settled.notify_all();
    }

    fn count_small_file(&self, store: &BackupStore, bytes: &[u8]) -> ClusterResult<StoredFile> {
        let mut saves = lock(&self.state);
        let before = saves.held.len();
        let file = save_small_file(store, bytes, &mut saves.held)?;
        if saves.held.len() > before {
            saves.files_stored += 1;
            saves.bytes_stored += bytes.len() as u64;
        }
        Ok(file)
    }
}

struct ListedFiles<'a> {
    store: &'a BackupStore,
    limit: &'a TransferLimit,
    source: &'a PartitionBackup,
    saves: &'a SharedSaves,
}

impl ListedFiles<'_> {
    fn store_listed_file(&self, position: usize) -> ClusterResult<ListedFile> {
        let listed = self.source.files.get(position).ok_or_else(|| {
            ClusterError::new(
                codes::INTERNAL_ERROR,
                format!("The partition backup lists no file at position {position}"),
            )
        })?;
        let _turn = self.limit.turn();
        let read = |offset: u64, length: u64| -> ClusterResult<Vec<u8>> {
            Ok(self.source.read_range(position, offset, length)?)
        };
        let sha256 = digest_of(&read, listed.bytes, BACKUP_FILE_CHUNK_BYTES)?;
        let file = StoredFile {
            sha256: sha256.clone(),
            bytes: listed.bytes,
        };
        if let Claim::Mine = self.saves.claim(&sha256) {
            let saved = save_checked_file(self.store, &read, &file, BACKUP_FILE_CHUNK_BYTES);
            self.saves
                .settle(&sha256, saved.is_ok().then_some(listed.bytes));
            saved?;
        }
        Ok(ListedFile {
            key: listed.key.clone(),
            file,
        })
    }

    fn store_every_listed_file(&self) -> ClusterResult<Vec<ListedFile>> {
        let count = self.source.files.len();
        let next = AtomicUsize::new(0);
        let failed = AtomicBool::new(false);
        let listed: Mutex<Vec<Option<ListedFile>>> = Mutex::new(vec![None; count]);
        let workers = BACKUP_FILES_AT_ONCE.min(count);
        let outcomes: Vec<ClusterResult<()>> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..workers)
                .map(|_| {
                    scope.spawn(|| -> ClusterResult<()> {
                        while !failed.load(Ordering::Acquire) {
                            let position = next.fetch_add(1, Ordering::AcqRel);
                            if position >= count {
                                break;
                            }
                            match self.store_listed_file(position) {
                                Ok(file) => lock(&listed)[position] = Some(file),
                                Err(error) => {
                                    failed.store(true, Ordering::Release);
                                    return Err(error);
                                }
                            }
                        }
                        Ok(())
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| {
                    handle.join().unwrap_or_else(|_| {
                        Err(ClusterError::new(
                            codes::INTERNAL_ERROR,
                            "A thread that saved backup files stopped before it finished",
                        ))
                    })
                })
                .collect()
        });
        for outcome in outcomes {
            outcome?;
        }
        listed
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .into_iter()
            .map(|file| {
                file.ok_or_else(|| {
                    ClusterError::new(
                        codes::INTERNAL_ERROR,
                        "A backup file was left unsaved by every thread",
                    )
                })
            })
            .collect()
    }
}

pub(crate) fn back_up_partition(
    store: &BackupStore,
    limit: &TransferLimit,
    source: &PartitionBackup,
    partition_id: u32,
) -> ClusterResult<Value> {
    let saves = SharedSaves {
        state: Mutex::new(Saves {
            held: stored_digests(store)?,
            ..Saves::default()
        }),
        settled: Condvar::new(),
    };
    let config = saves.count_small_file(store, &source.config)?;
    let manifest = saves.count_small_file(store, &source.manifest_bytes)?;
    let files = ListedFiles {
        store,
        limit,
        source,
        saves: &saves,
    }
    .store_every_listed_file()?;
    let partition = BackupPartition {
        partition_id: u64::from(partition_id),
        last_seq_no: source.last_seq_no as f64,
        manifest,
        files,
    };
    let tally = lock(&saves.state);
    let mut result = Map::with_capacity(4);
    result.insert("partition", backup_partition_wire(&partition));
    result.insert("config", stored_file_wire(&config));
    result.insert("filesStored", Value::from(tally.files_stored));
    result.insert("bytesStored", Value::from(tally.bytes_stored));
    Ok(Value::Object(result))
}
