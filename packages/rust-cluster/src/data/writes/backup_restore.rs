use narsil::replication::{BackupListedFile, BackupPartitionFiles, PartitionBackup};

use super::PrimaryWrites;
use crate::controller::lock;
use crate::data::backup_copy::CopyBackupFile;
use crate::error::ClusterResult;

pub(crate) struct StoredPartitionFiles {
    pub(crate) backup_name: String,
    pub(crate) config: Vec<u8>,
    pub(crate) manifest: Vec<u8>,
    pub(crate) files: Vec<BackupListedFile>,
    pub(crate) last_seq_no: u64,
}

impl PrimaryWrites {
    pub(crate) async fn backup_partition(
        &self,
        index_name: &str,
        partition_id: u32,
    ) -> ClusterResult<PartitionBackup> {
        let name = index_name.to_string();
        self.on_copies(move |copies| copies.backup_partition(&name, partition_id))
            .await
    }

    pub(crate) async fn restore_backup_partition(
        &self,
        index_name: &str,
        partition_id: u32,
        primary_term: u64,
        stored: StoredPartitionFiles,
        mut copy_file: Box<CopyBackupFile>,
    ) -> ClusterResult<()> {
        let partition = self.partitions.of(index_name, partition_id);
        let turn = partition.turn().await;
        let name = index_name.to_string();
        let restored = self
            .on_copies(move |copies| {
                let backup = BackupPartitionFiles {
                    backup_name: &stored.backup_name,
                    config: &stored.config,
                    manifest: &stored.manifest,
                    files: &stored.files,
                    last_seq_no: stored.last_seq_no,
                };
                copies.restore_backup_partition(
                    &name,
                    partition_id,
                    primary_term,
                    &backup,
                    copy_file.as_mut(),
                )
            })
            .await;
        if restored.is_ok() {
            lock(&partition.log).clear();
        }
        drop(turn);
        restored
    }
}
