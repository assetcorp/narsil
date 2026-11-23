mod layout;
mod merge;
mod spooled;

use std::collections::HashMap;
use std::io::Write;

use crate::engine::durable::archive::ArchiveCheckpoint;
use crate::engine::export::write::write_document_export;
use crate::error::Result;
use crate::format::index_configuration::decode_index_configuration;
use crate::format::manifest::SegmentManifest;
use crate::value::Value;
use layout::ArchivePart;
use spooled::SpooledFiles;

pub use merge::BackupArchivePartition;
pub use spooled::BackupFileReader;

/// One file that a [`BackupArchive`] reads: the listed file of a backup partition that holds its bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackupArchiveFile {
    /// The position of the partition in the list that [`BackupArchive::merge`] took.
    pub partition: usize,
    /// The position of the file in that partition's listed files.
    pub listed: usize,
    /// The file's length in bytes.
    pub bytes: u64,
}

/// The partitions of one backup merged into the snapshot that a device loads: one segment manifest over every
/// partition, which reads each file from where the backup lists it.
pub struct BackupArchive {
    config: Vec<u8>,
    manifest_bytes: Vec<u8>,
    manifest: SegmentManifest,
    keys: Vec<String>,
    files: Vec<BackupArchiveFile>,
    parts: Vec<ArchivePart>,
    length: u64,
}

impl BackupArchive {
    /// Returns every file of the archive in the order of its manifest.
    pub fn files(&self) -> &[BackupArchiveFile] {
        &self.files
    }

    /// Returns the length in bytes of the snapshot archive.
    pub fn byte_length(&self) -> u64 {
        self.length
    }

    /// Copies the bytes of the snapshot archive from `offset` into `buffer`, reading each file through `read`, and
    /// returns how many it copied, which is fewer than the buffer holds only at the end of the archive.
    ///
    /// # Errors
    ///
    /// Fails with the error of `read`, and with `PERSISTENCE_LOAD_FAILED` where a file is shorter than listed.
    pub fn read_at(
        &self,
        offset: u64,
        buffer: &mut [u8],
        read: &BackupFileReader,
    ) -> Result<usize> {
        layout::read_parts(&self.parts, offset, buffer, read)
    }

    /// Writes the document export of the backup to `out`, with `epoch` as the epoch of its header and each
    /// partition's backed-up sequence number as its position, reading each file through `read`.
    ///
    /// # Errors
    ///
    /// Fails with `PERSISTENCE_CRC_MISMATCH` or another envelope error where the configuration is damaged, with the
    /// error of `read`, and with `PERSISTENCE_SAVE_FAILED` where `out` refuses a write.
    pub fn write_document_export(
        &self,
        epoch: &str,
        read: BackupFileReader,
        out: &mut dyn Write,
    ) -> Result<()> {
        let (_, mut configuration) = decode_index_configuration(&self.config)?;
        configuration.insert("syncEpoch", Value::from(epoch));
        let positions: HashMap<String, (usize, u64)> = self
            .keys
            .iter()
            .zip(&self.files)
            .enumerate()
            .map(|(position, (key, file))| (key.clone(), (position, file.bytes)))
            .collect();
        let mut manifest = self.manifest.clone();
        manifest
            .partitions
            .sort_by_key(|partition| partition.partition_id);
        let checkpoint = ArchiveCheckpoint::over_store(
            Box::new(SpooledFiles { positions, read }),
            self.manifest_bytes.clone(),
            manifest,
            Some(epoch.to_string()),
        );
        write_document_export(&configuration, &checkpoint, out)
    }
}
