use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use narsil::Value;

use crate::error::{ClusterError, ClusterResult, codes};
use crate::node::generate_node_id;

const SPOOL_FILE_PREFIX: &str = "narsil-snapshot-";
#[cfg(unix)]
const OWNER_ONLY_FILE_MODE: u32 = 0o600;

/// A snapshot archive that a node writes to disk as it arrives, so that no archive sits whole in memory, with the
/// CRC32 and the length of the bytes written so far. Dropping the writer before [`SpoolWriter::finish`] deletes
/// the file.
pub(crate) struct SpoolWriter {
    file: Option<File>,
    path: PathBuf,
    hasher: crc32fast::Hasher,
    total_bytes: u64,
}

/// A whole snapshot archive on disk. Dropping it deletes the file.
pub(crate) struct SpooledSnapshot {
    pub(crate) path: PathBuf,
    pub(crate) total_bytes: u64,
    pub(crate) checksum: u32,
}

fn spool_failure(path: &Path, what: &str, error: &io::Error) -> ClusterError {
    ClusterError::new(
        codes::SNAPSHOT_SYNC_RESTORE_FAILED,
        format!("the snapshot could not be written to local storage: {what}: {error}"),
    )
    .with_detail("path", Value::String(path.display().to_string()))
}

fn open_owner_only(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(OWNER_ONLY_FILE_MODE);
    }
    options.open(path)
}

impl SpoolWriter {
    /// Creates an empty spool file in `directory` that only this process's user can read.
    pub(crate) fn create(directory: &Path) -> ClusterResult<SpoolWriter> {
        let path = directory.join(format!("{SPOOL_FILE_PREFIX}{}", generate_node_id()?));
        let file = open_owner_only(&path).map_err(|error| spool_failure(&path, "open", &error))?;
        Ok(SpoolWriter {
            file: Some(file),
            path,
            hasher: crc32fast::Hasher::new(),
            total_bytes: 0,
        })
    }

    /// Returns the CRC32 of every byte written so far.
    pub(crate) fn checksum(&self) -> u32 {
        self.hasher.clone().finalize()
    }

    /// Closes the file and hands over the whole archive.
    pub(crate) fn finish(mut self) -> ClusterResult<SpooledSnapshot> {
        if let Some(mut file) = self.file.take() {
            file.flush()
                .map_err(|error| spool_failure(&self.path, "flush", &error))?;
        }
        Ok(SpooledSnapshot {
            path: std::mem::take(&mut self.path),
            total_bytes: self.total_bytes,
            checksum: self.hasher.clone().finalize(),
        })
    }

    /// Appends `bytes` to the archive.
    pub(crate) fn append(&mut self, bytes: &[u8]) -> ClusterResult<()> {
        self.write_all(bytes)
            .map_err(|error| spool_failure(&self.path, "write", &error))
    }
}

impl Write for SpoolWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let Some(file) = self.file.as_mut() else {
            return Err(io::Error::other(
                "the snapshot spool file is already closed",
            ));
        };
        let written = file.write(bytes)?;
        self.hasher.update(&bytes[..written]);
        self.total_bytes += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.file.as_mut() {
            Some(file) => file.flush(),
            None => Ok(()),
        }
    }
}

impl Drop for SpoolWriter {
    fn drop(&mut self) {
        self.file.take();
        if !self.path.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl Drop for SpooledSnapshot {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
