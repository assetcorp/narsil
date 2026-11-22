use narsil::replication::{
    AppliedRun, CopyPosition, HeldTerm, PartitionCopies, PrimaryLimits, PrimaryRun, PrimaryWrite,
    ReplicatedEntry, WriteRecord,
};
use narsil::{Map, NarsilError};

use super::copies::LocalCopies;
use crate::error::ClusterResult;

impl LocalCopies {
    pub(super) fn primary_write(
        &self,
        index_name: &str,
        partition_id: u32,
        primary_term: u64,
        writes: Vec<PrimaryWrite>,
        limits: PrimaryLimits,
    ) -> ClusterResult<PrimaryRun> {
        self.refuse_orphaned(index_name)?;
        Ok(PartitionCopies::new(&self.engine).write(
            index_name,
            partition_id,
            primary_term,
            writes,
            limits,
        )?)
    }

    pub(super) fn replica_append(
        &self,
        index_name: &str,
        partition_id: u32,
        entries: &[ReplicatedEntry],
    ) -> ClusterResult<(AppliedRun, Option<NarsilError>)> {
        self.refuse_orphaned(index_name)?;
        let copies = PartitionCopies::new(&self.engine);
        let applied = copies.append(index_name, partition_id, entries)?;
        let failure = copies.failure(index_name, partition_id)?;
        Ok((applied, failure))
    }

    pub(super) fn held_term(
        &self,
        index_name: &str,
        partition_id: u32,
        seq_no: u64,
    ) -> ClusterResult<HeldTerm> {
        Ok(PartitionCopies::new(&self.engine).held_term(index_name, partition_id, seq_no)?)
    }

    pub(super) fn write_record(
        &self,
        index_name: &str,
        partition_id: u32,
        document_id: &str,
    ) -> ClusterResult<Option<WriteRecord>> {
        Ok(PartitionCopies::new(&self.engine).write_record(
            index_name,
            partition_id,
            document_id,
        )?)
    }

    pub(super) fn position(
        &self,
        index_name: &str,
        partition_id: u32,
    ) -> ClusterResult<CopyPosition> {
        Ok(PartitionCopies::new(&self.engine).position(index_name, partition_id)?)
    }

    pub(super) fn copy_failure(
        &self,
        index_name: &str,
        partition_id: u32,
    ) -> ClusterResult<Option<NarsilError>> {
        Ok(PartitionCopies::new(&self.engine).failure(index_name, partition_id)?)
    }

    pub(super) fn whole_document(
        &self,
        index_name: &str,
        document_id: &str,
    ) -> ClusterResult<Option<Map>> {
        Ok(PartitionCopies::new(&self.engine).document(index_name, document_id)?)
    }

    pub(super) fn reload_partition(
        &self,
        index_name: &str,
        partition_id: u32,
    ) -> ClusterResult<()> {
        Ok(PartitionCopies::new(&self.engine).reload_partition(index_name, partition_id)?)
    }

    pub(super) fn empty_partition(&self, index_name: &str, partition_id: u32) -> ClusterResult<()> {
        Ok(PartitionCopies::new(&self.engine).empty_partition(index_name, partition_id)?)
    }
}
