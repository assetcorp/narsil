use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::error::{ErrorCode, NarsilError, Result};

use super::constants::{DIRECTORY_IDENTITY_CHECK_INTERVAL_MS, SINGLE_NODE_PRIMARY_TERM};
use super::files::DurableDirectory;
use super::index_state::IndexState;
use super::lock::DirectoryLock;
use super::log_reader::read_marker;
use super::log_segment::LogStart;
use super::log_writer::PartitionLog;
use super::platform::{DirectoryIdentity, directory_identity};
use super::restore_journal::{finish_restore_journals, require_index_name};
use super::store_config::{DurabilityMode, StoreConfig};

type PartitionLogs = HashMap<String, HashMap<u32, Arc<PartitionLog>>>;

pub(crate) struct StoreInner {
    pub(crate) directory: DurableDirectory,
    pub(crate) config: StoreConfig,
    lock: Mutex<Option<DirectoryLock>>,
    identity: DirectoryIdentity,
    fatal: Mutex<Option<NarsilError>>,
    logs: RwLock<PartitionLogs>,
    indexes: Mutex<HashMap<String, Arc<IndexState>>>,
    stopping: Mutex<bool>,
    wake: Condvar,
    restore_commits: RwLock<()>,
}

pub(crate) fn store_poisoned() -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        "A thread failed while it held the durability store",
    )
}

fn store_shut_down(directory: &DurableDirectory) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!(
            "The engine has shut down and released the durability directory \"{}\", so it writes nothing more to it",
            directory.root().display()
        ),
    )
}

impl StoreInner {
    pub(crate) fn start(config: StoreConfig) -> Result<(Arc<StoreInner>, JoinHandle<()>)> {
        config.validate()?;
        let directory = DurableDirectory::new(&config.directory)?;
        let lock = DirectoryLock::acquire(directory.root())?;
        finish_restore_journals(&directory)?;
        let inner = Arc::new(StoreInner {
            identity: lock.identity(),
            directory,
            config,
            lock: Mutex::new(Some(lock)),
            fatal: Mutex::new(None),
            logs: RwLock::new(HashMap::new()),
            indexes: Mutex::new(HashMap::new()),
            stopping: Mutex::new(false),
            wake: Condvar::new(),
            restore_commits: RwLock::new(()),
        });
        let worker = inner.clone();
        let thread = std::thread::Builder::new()
            .name("narsil-durability".to_string())
            .spawn(move || run_background(worker))
            .map_err(|error| {
                NarsilError::new(
                    ErrorCode::PERSISTENCE_SAVE_FAILED,
                    format!("The engine cannot start its durability thread: {error}"),
                )
            })?;
        Ok((inner, thread))
    }

    pub(crate) fn fatal_error(&self) -> Option<NarsilError> {
        self.fatal
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    pub(crate) fn mark_fatal(&self, error: NarsilError) -> NarsilError {
        let stored = self
            .fatal
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get_or_insert(error)
            .clone();
        if let Ok(logs) = self.logs.read() {
            for log in logs.values().flat_map(HashMap::values) {
                log.fail(&stored);
            }
        }
        stored
    }

    pub(crate) fn guard<T>(&self, outcome: Result<T>) -> Result<T> {
        outcome.map_err(|error| match error.code() {
            ErrorCode::PERSISTENCE_FSYNC_FAILED
            | ErrorCode::PERSISTENCE_SAVE_FAILED
            | ErrorCode::PERSISTENCE_DELETE_FAILED => self.mark_fatal(error),
            _ => error,
        })
    }

    fn shut_down_started(&self) -> bool {
        *self
            .stopping
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub(crate) fn require_open(&self) -> Result<()> {
        if self.shut_down_started() {
            return Err(store_shut_down(&self.directory));
        }
        Ok(())
    }

    pub(crate) fn commit_restore<T>(&self, commit: impl FnOnce() -> Result<T>) -> Result<T> {
        let _open = self.restore_commits.read().map_err(|_| store_poisoned())?;
        self.require_open()?;
        commit()
    }

    pub(crate) fn require_healthy(&self) -> Result<()> {
        match self.fatal_error() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn directory_failure(&self) -> Option<NarsilError> {
        let root = self.directory.root().display();
        let failed = |message: String| {
            Some(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                message,
            ))
        };
        let cannot_check = |error: io::Error| {
            failed(format!(
                "The engine cannot check the durability directory \"{root}\", so it cannot confirm that a write is durable: {error}"
            ))
        };
        let lost = || {
            failed(format!(
                "The durability directory \"{root}\" is missing or is a different directory from the one that this instance opens at start-up, so a write to it is not durable"
            ))
        };
        match directory_identity(self.directory.root()) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => lost(),
            Err(error) => cannot_check(error),
            Ok(identity) if identity != self.identity => lost(),
            Ok(_) => {
                let lock = self
                    .lock
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                match lock.as_ref().map(DirectoryLock::holds) {
                    None | Some(Ok(true)) => None,
                    Some(Ok(false)) => failed(format!(
                        "The lock file of the durability directory \"{root}\" records another engine, which may be writing the same log"
                    )),
                    Some(Err(error)) => cannot_check(error),
                }
            }
        }
    }

    pub(crate) fn verify(&self) -> Result<()> {
        self.require_healthy()?;
        match self.directory_failure() {
            Some(error) => Err(self.mark_fatal(error)),
            None => Ok(()),
        }
    }

    pub(crate) fn index_state(&self, index_name: &str) -> Result<Arc<IndexState>> {
        require_index_name(index_name)?;
        let mut indexes = self.indexes.lock().map_err(|_| store_poisoned())?;
        Ok(indexes
            .entry(index_name.to_string())
            .or_insert_with(|| Arc::new(IndexState::new()))
            .clone())
    }

    pub(crate) fn logs_of(&self, index_name: &str) -> Result<Vec<Arc<PartitionLog>>> {
        let logs = self.logs.read().map_err(|_| store_poisoned())?;
        Ok(logs
            .get(index_name)
            .map(|partitions| partitions.values().cloned().collect())
            .unwrap_or_default())
    }

    pub(crate) fn register_log(
        &self,
        index_name: &str,
        partition_id: u32,
        start: LogStart,
    ) -> Result<()> {
        let log = Arc::new(PartitionLog::new(
            index_name,
            partition_id,
            self.config.segment_max_bytes,
            start,
        ));
        let previous = {
            let mut logs = self.logs.write().map_err(|_| store_poisoned())?;
            self.require_open()?;
            logs.entry(index_name.to_string())
                .or_default()
                .insert(partition_id, log)
        };
        if let Some(previous) = previous {
            self.guard(previous.close(&self.directory))?;
        }
        Ok(())
    }

    pub(crate) fn log(&self, index_name: &str, partition_id: u32) -> Result<Arc<PartitionLog>> {
        let known = self
            .logs
            .read()
            .map_err(|_| store_poisoned())?
            .get(index_name)
            .and_then(|partitions| partitions.get(&partition_id))
            .cloned();
        if let Some(log) = known {
            return Ok(log);
        }
        require_index_name(index_name)?;
        if read_marker(&self.directory, index_name, partition_id)?.is_some() {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!(
                    "The log of partition {partition_id} of index \"{index_name}\" holds records that recovery has not replayed"
                ),
            ));
        }
        let mut logs = self.logs.write().map_err(|_| store_poisoned())?;
        self.require_open()?;
        let log = logs
            .entry(index_name.to_string())
            .or_default()
            .entry(partition_id)
            .or_insert_with(|| {
                Arc::new(PartitionLog::new(
                    index_name,
                    partition_id,
                    self.config.segment_max_bytes,
                    LogStart {
                        active: None,
                        highest_seq_no: 0,
                        highest_durable_seq_no: 0,
                        primary_term: SINGLE_NODE_PRIMARY_TERM,
                    },
                ))
            });
        Ok(log.clone())
    }

    fn close_logs(&self, logs: Vec<Arc<PartitionLog>>) -> Result<()> {
        let mut outcome = Ok(());
        for log in logs {
            if let Err(error) = log.close(&self.directory) {
                outcome = Err(self.mark_fatal(error));
            }
        }
        outcome
    }

    pub(crate) fn forget_partitions_from(
        &self,
        index_name: &str,
        partition_count: u32,
    ) -> Result<()> {
        let removed: Vec<Arc<PartitionLog>> = {
            let mut logs = self.logs.write().map_err(|_| store_poisoned())?;
            let Some(partitions) = logs.get_mut(index_name) else {
                return Ok(());
            };
            let beyond: Vec<u32> = partitions
                .keys()
                .copied()
                .filter(|id| *id >= partition_count)
                .collect();
            beyond
                .iter()
                .filter_map(|id| partitions.remove(id))
                .collect()
        };
        self.close_logs(removed)
    }

    pub(crate) fn close_index_logs(&self, index_name: &str) -> Result<()> {
        let removed = self
            .logs
            .write()
            .map_err(|_| store_poisoned())?
            .remove(index_name);
        self.close_logs(removed.into_iter().flat_map(HashMap::into_values).collect())
    }

    pub(crate) fn forget_index(&self, index_name: &str) -> Result<()> {
        let outcome = self.close_index_logs(index_name);
        let removed = self
            .indexes
            .lock()
            .map_err(|_| store_poisoned())?
            .remove(index_name);
        if let Some(state) = removed {
            state.mark_replaced();
        }
        outcome
    }

    pub(crate) fn flush_logs(&self, logs: &[Arc<PartitionLog>]) -> Result<()> {
        let verify = || self.verify();
        for log in logs {
            self.guard(log.flush(&self.directory, &verify))?;
        }
        Ok(())
    }

    fn every_log(&self) -> Result<Vec<Arc<PartitionLog>>> {
        let logs = self.logs.read().map_err(|_| store_poisoned())?;
        Ok(logs.values().flat_map(HashMap::values).cloned().collect())
    }

    pub(crate) fn shut_down(&self, thread: Option<JoinHandle<()>>) -> Result<()> {
        if let Ok(mut stopping) = self.stopping.lock() {
            *stopping = true;
        }
        self.wake.notify_all();
        if let Some(thread) = thread {
            let _ = thread.join();
        }
        let _no_restore_commits = self
            .restore_commits
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        let outcome = self.close_logs(self.every_log()?);
        if let Some(mut lock) = self.lock.lock().ok().and_then(|mut lock| lock.take()) {
            lock.release();
        }
        outcome
    }
}

fn run_background(inner: Arc<StoreInner>) {
    let flushes = inner.config.mode == DurabilityMode::Async && inner.config.flush_interval_ms > 0;
    let flush_every = Duration::from_millis(inner.config.flush_interval_ms);
    let verify_every = Duration::from_millis(DIRECTORY_IDENTITY_CHECK_INTERVAL_MS);
    let tick = if flushes {
        flush_every.min(verify_every)
    } else {
        verify_every
    };
    let (mut flushed_at, mut verified_at) = (Instant::now(), Instant::now());
    loop {
        let stopping = match inner.stopping.lock() {
            Ok(guard) => match inner
                .wake
                .wait_timeout_while(guard, tick, |stopping| !*stopping)
            {
                Ok((guard, _)) => *guard,
                Err(_) => true,
            },
            Err(_) => true,
        };
        if stopping || inner.fatal_error().is_some() {
            return;
        }
        if flushes && flushed_at.elapsed() >= flush_every {
            if let Ok(logs) = inner.every_log() {
                let _ = inner.flush_logs(&logs);
            }
            flushed_at = Instant::now();
        }
        if verified_at.elapsed() >= verify_every {
            let _ = inner.verify();
            verified_at = Instant::now();
        }
    }
}
