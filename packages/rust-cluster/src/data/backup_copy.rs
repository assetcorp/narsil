use std::io::Write;

use narsil::replication::{BackupPartitionFiles, PartitionBackup, PartitionCopies};

use super::copies::LocalCopies;
use crate::error::ClusterResult;

pub(crate) type CopyBackupFile = dyn FnMut(usize, &mut dyn Write) -> narsil::Result<()> + Send;

impl LocalCopies {
    pub(crate) fn backup_partition(
        &self,
        index_name: &str,
        partition_id: u32,
    ) -> ClusterResult<PartitionBackup> {
        self.refuse_orphaned(index_name)?;
        Ok(PartitionCopies::new(&self.engine).backup_partition(index_name, partition_id)?)
    }

    pub(super) fn restore_backup_partition(
        &self,
        index_name: &str,
        partition_id: u32,
        primary_term: u64,
        backup: &BackupPartitionFiles<'_>,
        copy_file: &mut CopyBackupFile,
    ) -> ClusterResult<()> {
        self.refuse_orphaned(index_name)?;
        Ok(PartitionCopies::new(&self.engine).restore_backup_partition(
            index_name,
            partition_id,
            primary_term,
            backup,
            copy_file,
        )?)
    }
}
