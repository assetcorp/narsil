use std::sync::Arc;

use narsil::replication::{BackupManifest, decode_backup_manifest};
use narsil::{AdapterError, NarsilError, PersistenceAdapter, Value};

use super::constants::{BACKUP_MANIFEST_READS_AT_ONCE, CLUSTER_UUID_KEY, MAX_CLUSTER_UUID_BYTES};
use super::keys::{BackupKeys, store_without_save_if_absent, validate_backup_name};
use super::manifest::stored_files_of;
use super::types::{BackupListing, BackupSummary, ClusterBackupConfig, DamagedBackup};
use crate::coordinator::etcd::EtcdCoordinator;
use crate::error::{ClusterError, ClusterResult, codes};

const UUID_BYTES: usize = 16;
const UUID_TEXT_LENGTH: usize = 36;
const UUID_VERSION_MASK: u8 = 0x0f;
const UUID_VERSION_FOUR: u8 = 0x40;
const UUID_VARIANT_MASK: u8 = 0x3f;
const UUID_VARIANT: u8 = 0x80;

#[derive(Clone)]
pub(crate) struct BackupStore {
    pub(crate) adapter: Arc<dyn PersistenceAdapter>,
    pub(crate) key_prefix: String,
    pub(crate) keys: Arc<BackupKeys>,
}

pub(crate) fn adapter_failure(
    code: &str,
    verb: &str,
    key: &str,
    error: AdapterError,
) -> ClusterError {
    match error.downcast::<NarsilError>() {
        Ok(error) => ClusterError::from(*error),
        Err(error) => match error.downcast::<ClusterError>() {
            Ok(error) => *error,
            Err(error) => ClusterError::new(
                code,
                format!("The backup store failed to {verb} \"{key}\": {error}"),
            )
            .with_detail("key", Value::from(key)),
        },
    }
}

impl BackupStore {
    pub(crate) fn open(config: &ClusterBackupConfig) -> ClusterResult<BackupStore> {
        Ok(BackupStore {
            adapter: Arc::clone(&config.store),
            key_prefix: config.key_prefix.clone(),
            keys: Arc::new(BackupKeys::new(&config.key_prefix)?),
        })
    }

    pub(crate) async fn run<T, F>(&self, work: F) -> ClusterResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&BackupStore) -> ClusterResult<T> + Send + 'static,
    {
        let store = self.clone();
        tokio::task::spawn_blocking(move || work(&store))
            .await
            .map_err(|_| {
                ClusterError::new(
                    codes::INTERNAL_ERROR,
                    "A call on the backup store stopped before it finished",
                )
            })?
    }

    pub(crate) fn load(&self, key: &str) -> ClusterResult<Option<Vec<u8>>> {
        self.adapter
            .load(key)
            .map_err(|error| adapter_failure(codes::PERSISTENCE_LOAD_FAILED, "load", key, error))
    }

    pub(crate) fn save(&self, key: &str, data: &[u8]) -> ClusterResult<()> {
        self.adapter
            .save(key, data)
            .map_err(|error| adapter_failure(codes::PERSISTENCE_SAVE_FAILED, "save", key, error))
    }

    pub(crate) fn delete(&self, key: &str) -> ClusterResult<()> {
        self.adapter
            .delete(key)
            .map_err(|error| adapter_failure(codes::PERSISTENCE_SAVE_FAILED, "delete", key, error))
    }

    pub(crate) fn list(&self, prefix: &str) -> ClusterResult<Vec<String>> {
        self.adapter
            .list(prefix)
            .map_err(|error| adapter_failure(codes::PERSISTENCE_LOAD_FAILED, "list", prefix, error))
    }
}

pub(crate) fn summary_of(manifest: &BackupManifest) -> BackupSummary {
    let files = stored_files_of(manifest);
    BackupSummary {
        name: manifest.name.clone(),
        index_name: manifest.index_name.clone(),
        started_at: manifest.started_at,
        completed_at: manifest.completed_at,
        partition_count: manifest.partition_count,
        replication_factor: manifest.replication_factor,
        files: files.len() as u64,
        bytes: files
            .iter()
            .fold(0u64, |total, file| total.saturating_add(file.bytes)),
    }
}

pub(crate) fn backup_not_found(store: &BackupStore, backup_name: &str) -> ClusterError {
    ClusterError::new(
        codes::BACKUP_NOT_FOUND,
        format!("The store holds no backup named '{backup_name}'"),
    )
    .with_detail("backupName", Value::from(backup_name))
    .with_detail("keyPrefix", Value::from(store.key_prefix.as_str()))
}

pub(crate) fn backup_name_taken(backup_name: &str) -> ClusterError {
    ClusterError::new(
        codes::BACKUP_ALREADY_EXISTS,
        format!("The store already holds a backup named '{backup_name}'"),
    )
    .with_detail("backupName", Value::from(backup_name))
}

pub(crate) fn holds_manifest(store: &BackupStore, backup_name: &str) -> ClusterResult<bool> {
    let key = store.keys.manifest(backup_name)?;
    Ok(store.list(&key)?.contains(&key))
}

pub(crate) fn read_backup_manifest(
    store: &BackupStore,
    backup_name: &str,
) -> ClusterResult<BackupManifest> {
    let Some(bytes) = store.load(&store.keys.manifest(backup_name)?)? else {
        return Err(backup_not_found(store, backup_name));
    };
    Ok(decode_backup_manifest(&bytes, backup_name)?)
}

pub(crate) fn list_backup_names(store: &BackupStore) -> ClusterResult<Vec<String>> {
    let manifests = &store.keys.manifests;
    let mut names: Vec<String> = store
        .list(manifests)?
        .iter()
        .filter_map(|key| key.strip_prefix(manifests.as_str()))
        .filter_map(|name| validate_backup_name(name).ok())
        .collect();
    names.sort();
    Ok(names)
}

enum ManifestRead {
    Read(BackupManifest),
    Damaged(String, ClusterError),
}

fn read_listed(store: &BackupStore, name: &str) -> ClusterResult<Option<ManifestRead>> {
    let Some(bytes) = store.load(&store.keys.manifest(name)?)? else {
        return Ok(None);
    };
    match decode_backup_manifest(&bytes, name) {
        Ok(manifest) => Ok(Some(ManifestRead::Read(manifest))),
        Err(error) if error.code() == narsil::ErrorCode::BACKUP_DAMAGED => Ok(Some(
            ManifestRead::Damaged(name.to_string(), ClusterError::from(error)),
        )),
        Err(error) => Err(error.into()),
    }
}

fn read_every_listed(store: &BackupStore) -> ClusterResult<Vec<ManifestRead>> {
    let names = list_backup_names(store)?;
    let mut reads = Vec::with_capacity(names.len());
    for batch in names.chunks(BACKUP_MANIFEST_READS_AT_ONCE) {
        let batch_reads = std::thread::scope(|scope| {
            let handles: Vec<_> = batch
                .iter()
                .map(|name| scope.spawn(move || read_listed(store, name)))
                .collect();
            handles
                .into_iter()
                .map(|handle| {
                    handle.join().unwrap_or_else(|_| {
                        Err(ClusterError::new(
                            codes::INTERNAL_ERROR,
                            "A read of a backup manifest stopped before it finished",
                        ))
                    })
                })
                .collect::<Vec<_>>()
        });
        for read in batch_reads {
            if let Some(read) = read? {
                reads.push(read);
            }
        }
    }
    Ok(reads)
}

pub(crate) fn read_every_readable_manifest(
    store: &BackupStore,
) -> ClusterResult<Vec<BackupManifest>> {
    Ok(read_every_listed(store)?
        .into_iter()
        .filter_map(|read| match read {
            ManifestRead::Read(manifest) => Some(manifest),
            ManifestRead::Damaged(..) => None,
        })
        .collect())
}

pub(crate) fn read_every_manifest(store: &BackupStore) -> ClusterResult<Vec<BackupManifest>> {
    read_every_listed(store)?
        .into_iter()
        .map(|read| match read {
            ManifestRead::Read(manifest) => Ok(manifest),
            ManifestRead::Damaged(_, error) => Err(error),
        })
        .collect()
}

pub(crate) fn list_backups(store: &BackupStore) -> ClusterResult<Vec<BackupListing>> {
    let mut listing: Vec<BackupListing> = read_every_listed(store)?
        .into_iter()
        .map(|read| match read {
            ManifestRead::Read(manifest) => BackupListing::Summary(summary_of(&manifest)),
            ManifestRead::Damaged(name, error) => BackupListing::Damaged(DamagedBackup {
                name,
                code: error.code().to_string(),
                message: error.message().to_string(),
            }),
        })
        .collect();
    listing.sort_by(|left, right| left.name().cmp(right.name()));
    Ok(listing)
}

fn decoded_uuid(bytes: &[u8]) -> Option<String> {
    String::from_utf8(bytes.to_vec()).ok()
}

fn random_uuid() -> ClusterResult<String> {
    let mut bytes = [0u8; UUID_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| {
        ClusterError::new(
            codes::INTERNAL_ERROR,
            format!("The controller could not read random bytes for the cluster's UUID: {error}"),
        )
    })?;
    bytes[6] = (bytes[6] & UUID_VERSION_MASK) | UUID_VERSION_FOUR;
    bytes[8] = (bytes[8] & UUID_VARIANT_MASK) | UUID_VARIANT;
    let mut text = String::with_capacity(UUID_TEXT_LENGTH);
    for (at, byte) in bytes.iter().enumerate() {
        if matches!(at, 4 | 6 | 8 | 10) {
            text.push('-');
        }
        text.push_str(&format!("{byte:02x}"));
    }
    Ok(text)
}

pub(crate) async fn cluster_uuid_of(coordinator: &EtcdCoordinator) -> ClusterResult<String> {
    let lost = || {
        ClusterError::new(
            codes::CONTROLLER_METADATA_INVALID,
            format!("The coordinator lost the key '{CLUSTER_UUID_KEY}'"),
        )
        .with_detail("key", Value::from(CLUSTER_UUID_KEY))
    };
    if let Some(stored) = coordinator.get(CLUSTER_UUID_KEY).await?
        && !stored.is_empty()
    {
        return decoded_uuid(&stored).ok_or_else(lost);
    }
    let fresh = random_uuid()?;
    coordinator
        .compare_and_set(CLUSTER_UUID_KEY, None, fresh.as_bytes())
        .await?;
    match coordinator.get(CLUSTER_UUID_KEY).await? {
        Some(written) if !written.is_empty() => decoded_uuid(&written).ok_or_else(lost),
        _ => Err(lost()),
    }
}

fn claimed_by(bytes: &[u8]) -> String {
    if bytes.len() > MAX_CLUSTER_UUID_BYTES {
        return String::new();
    }
    decoded_uuid(bytes).unwrap_or_default()
}

pub(crate) fn claim_backup_store(store: &BackupStore, cluster_uuid: &str) -> ClusterResult<()> {
    let claim_key = &store.keys.claim;
    let mut claim = store.load(claim_key)?;
    if claim.is_none() {
        let saved = store
            .adapter
            .save_if_absent(claim_key, cluster_uuid.as_bytes())
            .ok_or_else(store_without_save_if_absent)?
            .map_err(|error| {
                adapter_failure(codes::PERSISTENCE_SAVE_FAILED, "save", claim_key, error)
            })?;
        if saved {
            return Ok(());
        }
        claim = store.load(claim_key)?;
    }
    match claim {
        Some(claim) if claimed_by(&claim) == cluster_uuid => Ok(()),
        _ => Err(ClusterError::new(
            codes::BACKUP_STORE_CLAIMED,
            format!(
                "Another cluster writes its backups under the key prefix '{}', so this cluster writes nothing there",
                store.key_prefix
            ),
        )
        .with_detail("keyPrefix", Value::from(store.key_prefix.as_str()))),
    }
}
