use super::{CopyPosition, HeldTerm, PartitionCopies, WriteRecord};
use crate::error::{NarsilError, Result};
use crate::value::Map;

impl PartitionCopies<'_> {
    /// Returns the UUID that the index keeps as a cluster copy, or `None` for a standalone index.
    pub fn index_uuid(&self, index: &str) -> Result<Option<String>> {
        let state = self.engine.open_index(index)?;
        Ok(state.replicated_copy().map(|copy| copy.uuid.clone()))
    }

    /// Returns the number of partitions that the local copy of the index has.
    pub fn partition_count(&self, index: &str) -> Result<usize> {
        Ok(self.engine.open_index(index)?.partitions().len())
    }

    /// Returns the partitions that the node recorded as held, in ascending order.
    pub fn held_partitions(&self, index: &str) -> Result<Vec<u32>> {
        let state = self.engine.open_index(index)?;
        Ok(state
            .replicated_copy()
            .map(|copy| copy.held())
            .unwrap_or_default())
    }

    /// Returns the partitions that hold a document or an entry, in ascending order.
    pub fn partitions_with_data(&self, index: &str) -> Result<Vec<u32>> {
        let state = self.engine.open_index(index)?;
        let mut found = Vec::new();
        for (at, partition) in state.partitions().iter().enumerate() {
            let partition_id = at as u32;
            let logged = match state.replicated_copy() {
                Some(copy) if at < copy.partition_count() => {
                    copy.partition(&state.name, partition_id)?.position.seq_no > 0
                }
                _ => false,
            };
            if logged || partition.snapshot().document_count() > 0 {
                found.push(partition_id);
            }
        }
        Ok(found)
    }

    /// Returns the highest entry that the copy of `partition` holds.
    pub fn position(&self, index: &str, partition: u32) -> Result<CopyPosition> {
        let state = self.engine.open_index(index)?;
        let copy = super::copy_of(&state)?;
        Ok(copy.partition(&state.name, partition)?.position)
    }

    /// Returns the failure that stops the copy of `partition` from taking entries, where it has one.
    pub fn failure(&self, index: &str, partition: u32) -> Result<Option<NarsilError>> {
        let state = self.engine.open_index(index)?;
        let copy = super::copy_of(&state)?;
        Ok(copy.partition(&state.name, partition)?.failure.clone())
    }

    /// Returns the term that the copy's history gives for the entry numbered `seq_no`.
    pub fn held_term(&self, index: &str, partition: u32, seq_no: u64) -> Result<HeldTerm> {
        let state = self.engine.open_index(index)?;
        let copy = super::copy_of(&state)?;
        Ok(copy.partition(&state.name, partition)?.held_term(seq_no))
    }

    /// Returns the entry that last wrote the document, or `None` where the copy holds no record of one.
    pub fn write_record(
        &self,
        index: &str,
        partition: u32,
        document_id: &str,
    ) -> Result<Option<WriteRecord>> {
        let state = self.engine.open_index(index)?;
        let copy = super::copy_of(&state)?;
        Ok(copy
            .partition(&state.name, partition)?
            .record_of(document_id))
    }

    /// Returns the document with every stored field and vector, as an index entry carries it.
    pub fn document(&self, index: &str, document_id: &str) -> Result<Option<Map>> {
        self.engine.open_index(index)?.full_document(document_id)
    }
}
