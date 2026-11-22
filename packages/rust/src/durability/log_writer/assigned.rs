use super::super::files::DurableDirectory;
use super::super::log_segment::LogWrite;
use super::{MAX_SEQ_NO, PartitionLog};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::Value;

impl PartitionLog {
    /// Appends `writes` under `primary_term`, numbered from `first_seq_no`, which must follow the last record of
    /// the log, so that the log keeps the numbers and the term that the partition's primary assigned.
    pub(crate) fn append_assigned(
        &self,
        directory: &DurableDirectory,
        first_seq_no: u64,
        primary_term: u64,
        writes: Vec<LogWrite>,
    ) -> Result<()> {
        let mut state = self.lock()?;
        self.usable(&state)?;
        if writes.is_empty() {
            return Ok(());
        }
        let follows = first_seq_no == state.highest_appended.saturating_add(1);
        if !follows || primary_term > MAX_SEQ_NO {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!(
                    "Partition {} of index \"{}\" takes record {} next, so it cannot log record {first_seq_no} of term {primary_term}",
                    self.partition_id,
                    self.index_name,
                    state.highest_appended.saturating_add(1)
                ),
            )
            .with_details([
                ("indexName", Value::from(self.index_name.as_str())),
                ("partitionId", Value::from(self.partition_id)),
                ("seqNo", Value::from(first_seq_no)),
            ]));
        }
        state.primary_term = primary_term;
        let outcome = self.append_locked(&mut state, directory, writes);
        self.record_failure(&mut state, &outcome);
        outcome.map(|_| ())
    }
}
