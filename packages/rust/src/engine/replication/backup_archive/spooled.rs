use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::durability::checkpoint_store::{CheckpointStore, FileLength, FileSink};
use crate::error::{ErrorCode, NarsilError, Result};

/// Reads `length` bytes from `offset` of the file at a position in [`super::BackupArchive::files`].
pub type BackupFileReader = Arc<dyn Fn(usize, u64, u64) -> Result<Vec<u8>> + Send + Sync>;

pub(super) struct SpooledFiles {
    pub(super) positions: HashMap<String, (usize, u64)>,
    pub(super) read: BackupFileReader,
}

fn read_only(key: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!("The files of a backup are read-only, so \"{key}\" cannot be written"),
    )
}

fn unlisted(key: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("The backup lists no file \"{key}\""),
    )
}

impl SpooledFiles {
    fn position(&self, key: &str) -> Result<(usize, u64)> {
        self.positions
            .get(key)
            .copied()
            .ok_or_else(|| unlisted(key))
    }
}

impl CheckpointStore for SpooledFiles {
    fn read_within(&self, key: &str, limit: u64) -> Result<Option<Vec<u8>>> {
        let Some((position, bytes)) = self.positions.get(key).copied() else {
            return Ok(None);
        };
        if bytes > limit {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED,
                format!(
                    "The backup file \"{key}\" holds {bytes} bytes, above the {limit} that a read takes"
                ),
            ));
        }
        (self.read)(position, 0, bytes).map(Some)
    }

    fn read_range(&self, key: &str, offset: u64, length: u64) -> Result<Vec<u8>> {
        let (position, _) = self.position(key)?;
        (self.read)(position, offset, length)
    }

    fn length(&self, key: &str) -> Result<FileLength> {
        Ok(match self.positions.get(key) {
            Some((_, bytes)) => FileLength::Known(*bytes),
            None => FileLength::Missing,
        })
    }

    fn begin_file(&self, key: &str) -> Result<FileSink> {
        Err(read_only(key))
    }

    fn finish_file(&self, _sink: FileSink) -> Result<Option<PathBuf>> {
        Err(read_only("a staged file"))
    }

    fn sync_directories(&self, _directories: &[PathBuf]) -> Result<()> {
        Ok(())
    }

    fn write_commit(&self, key: &str, _bytes: &[u8]) -> Result<()> {
        Err(read_only(key))
    }

    fn remove(&self, key: &str) -> Result<()> {
        Err(read_only(key))
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>> {
        let mut keys: Vec<String> = self
            .positions
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect();
        keys.sort();
        Ok(keys)
    }
}
