use std::fmt;
use std::sync::Arc;

use narsil::PersistenceAdapter;

/// Where a cluster keeps its backups, which is a store outside the cluster.
///
/// Give every node of the cluster the same settings, because the primary of each partition uploads that
/// partition's files and the controller writes each backup's manifest.
#[derive(Clone)]
pub struct ClusterBackupConfig {
    /// The store that holds the backups. It must offer
    /// [`PersistenceAdapter::save_if_absent`], or the node refuses to start.
    pub store: Arc<dyn PersistenceAdapter>,
    /// This cluster writes every backup under this key prefix, and it refuses to write under a prefix that another
    /// cluster has written to. Use segments of letters, digits, `.`, `_`, and `-`, joined by `/`.
    pub key_prefix: String,
}

impl fmt::Debug for ClusterBackupConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClusterBackupConfig")
            .field("key_prefix", &self.key_prefix)
            .finish_non_exhaustive()
    }
}

/// What a cluster records about one backup.
#[derive(Debug, Clone, PartialEq)]
pub struct BackupSummary {
    /// The name the backup was taken under.
    pub name: String,
    /// The index the backup holds.
    pub index_name: String,
    /// The backup started at this many milliseconds since the epoch, and it holds every write acknowledged before
    /// then.
    pub started_at: f64,
    /// The controller wrote the backup's manifest at this many milliseconds since the epoch.
    pub completed_at: f64,
    /// The index had this many partitions, and a restore creates the same number.
    pub partition_count: u64,
    /// The index kept this many replicas of each partition, and a restore asks for the same number.
    pub replication_factor: f64,
    /// The backup lists this many stored files, counting each partition's manifest and the index configuration.
    pub files: u64,
    /// The files the backup lists hold this many bytes in total, including files that other backups share.
    pub bytes: u64,
}

/// A backup whose manifest the cluster can't read, which a listing shows in place of its summary.
#[derive(Debug, Clone, PartialEq)]
pub struct DamagedBackup {
    /// The name that the manifest is stored under.
    pub name: String,
    /// Why the manifest can't be read, with the code `BACKUP_DAMAGED`.
    pub code: String,
    /// The reason in words.
    pub message: String,
}

/// One entry of a backup listing: a summary, or a [`DamagedBackup`] where the manifest can't be read.
#[derive(Debug, Clone, PartialEq)]
pub enum BackupListing {
    /// A backup whose manifest decodes.
    Summary(BackupSummary),
    /// A backup whose manifest fails to decode.
    Damaged(DamagedBackup),
}

impl BackupListing {
    /// Returns the name that the backup is stored under.
    pub fn name(&self) -> &str {
        match self {
            BackupListing::Summary(summary) => &summary.name,
            BackupListing::Damaged(damaged) => &damaged.name,
        }
    }
}

/// How far a backup, a restore, or a deletion has gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackupProgress {
    /// The operation has finished this many partitions, or this many files for a deletion.
    pub done: u64,
    /// The operation covers this many partitions, or this many files for a deletion, and 0 until it knows.
    pub total: u64,
}

/// Called whenever a backup operation reports more progress.
pub type BackupProgressHandler = Arc<dyn Fn(BackupProgress) + Send + Sync>;

/// The rules that place the partitions of a restored index.
#[derive(Debug, Clone, PartialEq)]
pub struct RestoreConstraints {
    /// Set this to true to spread each partition's copies across zones.
    pub zone_awareness: bool,
    /// The node attribute that holds a node's zone.
    pub zone_attribute: String,
    /// The most copies that one node holds, or `None` for no limit.
    pub max_shards_per_node: Option<u64>,
}

/// Where a restore puts a backup, and how the cluster places the restored copies.
#[derive(Clone, Default)]
pub struct RestoreBackupOptions {
    /// The restore creates the index under this name, and it fails where the name is taken.
    pub index_name: String,
    /// The restored index keeps this many replicas of each partition, or the backup's number when left out.
    pub replication_factor: Option<u64>,
    /// The rules that place the restored partitions, or the backup's rules when left out.
    pub constraints: Option<RestoreConstraints>,
    /// Called whenever the restore reports more progress.
    pub on_progress: Option<BackupProgressHandler>,
}

/// How a backup of an index runs.
#[derive(Clone, Default)]
pub struct CreateBackupOptions {
    /// Set this to true to add every node's popular query suggestion history of the index to the backup. A node
    /// that gives no answer adds nothing.
    pub query_history: bool,
    /// Called whenever the backup reports more progress.
    pub on_progress: Option<BackupProgressHandler>,
}
