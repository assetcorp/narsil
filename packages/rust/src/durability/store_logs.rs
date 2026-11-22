use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::error::{ErrorCode, NarsilError, Result};

use super::constants::SINGLE_NODE_PRIMARY_TERM;
use super::log_reader::read_marker;
use super::log_segment::LogStart;
use super::log_writer::PartitionLog;
use super::restore_journal::require_index_name;
use super::store_inner::{StoreInner, store_poisoned};

impl StoreInner {
    fn records_previous_documents(&self, index_name: &str) -> Result<Arc<AtomicBool>> {
        Ok(self
            .index_state(index_name)?
            .records_previous_documents
            .clone())
    }

    fn fails_alone(&self, log: &PartitionLog) -> bool {
        self.index_state(log.index_name())
            .is_ok_and(|state| state.fails_partitions_alone.load(Ordering::Acquire))
    }

    pub(crate) fn guard_log<T>(&self, log: &PartitionLog, outcome: Result<T>) -> Result<T> {
        if self.fails_alone(log) {
            return outcome;
        }
        self.guard(outcome)
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
            self.records_previous_documents(index_name)?,
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
            self.guard_log(&previous, previous.close(&self.directory))?;
        }
        Ok(())
    }

    pub(crate) fn close_log(&self, index_name: &str, partition_id: u32) -> Result<()> {
        let removed = self
            .logs
            .write()
            .map_err(|_| store_poisoned())?
            .get_mut(index_name)
            .and_then(|partitions| partitions.remove(&partition_id));
        match removed {
            Some(log) => self.guard_log(&log, log.close(&self.directory)),
            None => Ok(()),
        }
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
        let records_previous_documents = self.records_previous_documents(index_name)?;
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
                    records_previous_documents,
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

    pub(crate) fn close_logs(&self, logs: Vec<Arc<PartitionLog>>) -> Result<()> {
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

    pub(crate) fn flush_logs(&self, logs: &[Arc<PartitionLog>]) -> Result<()> {
        let verify = || self.verify();
        let mut outcome = Ok(());
        for log in logs {
            let flushed = self.guard_log(log, log.flush(&self.directory, &verify));
            if outcome.is_ok() {
                outcome = flushed;
            }
        }
        outcome
    }

    pub(crate) fn every_log(&self) -> Result<Vec<Arc<PartitionLog>>> {
        let logs = self.logs.read().map_err(|_| store_poisoned())?;
        Ok(logs.values().flat_map(HashMap::values).cloned().collect())
    }
}
