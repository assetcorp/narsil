use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::MAX_FILE_BYTES;

use super::log_bytes::LogBytes;
use super::platform::{remove_file, rename_replacing, sync_directory};
use super::staged_file::StagedFile;

pub(crate) const TEMPORARY_MARK: &str = ".tmp-";

pub(crate) fn fsync_failed(key: &str, error: &io::Error) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_FSYNC_FAILED,
        format!(
            "fsync failed for \"{key}\"; the write is not acknowledged and the node must recover from the durable log: {error}"
        ),
    )
}

pub(crate) fn write_failed(key: &str, error: &io::Error) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!("Write to \"{key}\" failed; the write is not acknowledged: {error}"),
    )
}

pub(crate) fn read_failed(key: &str, error: &io::Error) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("Failed to read \"{key}\": {error}"),
    )
}

pub(crate) fn range_outside(key: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("\"{key}\" ends before the bytes a read asked for"),
    )
}

fn delete_failed(key: &str, error: &io::Error) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_DELETE_FAILED,
        format!("Failed to delete \"{key}\": {error}"),
    )
}

fn invalid_key(key: &str, reason: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!("Invalid key \"{}\": {reason}", key.escape_debug()),
    )
}

pub(crate) fn require_valid_key(key: &str) -> Result<()> {
    if key.is_empty() {
        return Err(invalid_key(key, "empty"));
    }
    if key.contains('\0') {
        return Err(invalid_key(key, "null byte detected"));
    }
    let traverses = key.split('/').any(|part| {
        part.is_empty() || part == "." || part == ".." || part.contains('\\') || part.contains(':')
    });
    if traverses {
        return Err(invalid_key(key, "path traversal detected"));
    }
    Ok(())
}

fn is_missing(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
}

pub(crate) struct DurableDirectory {
    root: PathBuf,
    log_bytes: LogBytes,
}

impl DurableDirectory {
    pub(crate) fn new(root: &Path) -> Result<DurableDirectory> {
        if root.as_os_str().is_empty() || root.to_string_lossy().trim().is_empty() {
            return Err(NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                "Durable directory requires a non-empty root path",
            ));
        }
        let root = std::path::absolute(root).map_err(|error| {
            NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                format!(
                    "The durability directory \"{}\" cannot be resolved: {error}",
                    root.display()
                ),
            )
        })?;
        Ok(DurableDirectory {
            root,
            log_bytes: LogBytes::default(),
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Returns the ledger of the bytes that each index's log and history segments hold in the directory.
    pub(crate) fn log_bytes(&self) -> &LogBytes {
        &self.log_bytes
    }

    /// Measures every log and history segment of `index_name` once, which the ledger then keeps up to date.
    pub(crate) fn measure_log_bytes(&self, index_name: &str) -> Result<()> {
        self.log_bytes.seed(index_name, || {
            let mut files = Vec::new();
            for prefix in [
                format!("{index_name}/wal/"),
                format!("{index_name}/history/"),
            ] {
                for key in self.list(&prefix)? {
                    if let Some(bytes) = self.byte_length(&key)? {
                        files.push((key, bytes));
                    }
                }
            }
            Ok(files)
        })
    }

    pub(crate) fn path_of(&self, key: &str) -> Result<PathBuf> {
        require_valid_key(key)?;
        let mut path = self.root.clone();
        for part in key.split('/') {
            path.push(part);
        }
        Ok(path)
    }

    fn parent_of(&self, key: &str) -> Result<(PathBuf, PathBuf)> {
        let path = self.path_of(key)?;
        let parent = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.root.clone());
        Ok((path, parent))
    }

    pub(crate) fn ensure_parent(&self, key: &str) -> Result<(PathBuf, PathBuf)> {
        let (path, parent) = self.parent_of(key)?;
        std::fs::create_dir_all(&parent).map_err(|error| write_failed(key, &error))?;
        Ok((path, parent))
    }

    pub(crate) fn byte_length(&self, key: &str) -> Result<Option<u64>> {
        match std::fs::metadata(self.path_of(key)?) {
            Ok(metadata) if metadata.is_file() => Ok(Some(metadata.len())),
            Ok(_) => Ok(None),
            Err(error) if is_missing(&error) => Ok(None),
            Err(error) => Err(read_failed(key, &error)),
        }
    }

    pub(crate) fn read_within(&self, key: &str, limit: u64) -> Result<Option<Vec<u8>>> {
        let mut file = match File::open(self.path_of(key)?) {
            Ok(file) => file,
            Err(error) if is_missing(&error) => return Ok(None),
            Err(error) => return Err(read_failed(key, &error)),
        };
        let length = file
            .metadata()
            .map_err(|error| read_failed(key, &error))?
            .len();
        if length > limit {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED,
                format!("\"{key}\" holds {length} bytes, above the limit of {limit} bytes"),
            ));
        }
        let mut bytes = Vec::with_capacity(length as usize);
        (&mut file)
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| read_failed(key, &error))?;
        if bytes.len() as u64 > limit {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED,
                format!("\"{key}\" grew past the limit of {limit} bytes while it was read"),
            ));
        }
        Ok(Some(bytes))
    }

    pub(crate) fn sync_directory_of(&self, key: &str) -> Result<()> {
        let (_, parent) = self.parent_of(key)?;
        sync_directory(&parent).map_err(|error| fsync_failed(&parent.to_string_lossy(), &error))
    }

    pub(crate) fn sync_path(&self, directory: &Path) -> Result<()> {
        sync_directory(directory)
            .map_err(|error| fsync_failed(&directory.to_string_lossy(), &error))
    }

    pub(crate) fn create_staged(&self, key: &str) -> Result<StagedFile> {
        let (path, parent) = self.ensure_parent(key)?;
        StagedFile::create(key, path, parent)
    }

    pub(crate) fn read_range(&self, key: &str, offset: u64, length: u64) -> Result<Vec<u8>> {
        let mut file = File::open(self.path_of(key)?).map_err(|error| read_failed(key, &error))?;
        let found = file
            .metadata()
            .map_err(|error| read_failed(key, &error))?
            .len();
        let inside = offset
            .checked_add(length)
            .is_some_and(|end| end <= found && length <= MAX_FILE_BYTES);
        if !inside {
            return Err(range_outside(key));
        }
        let mut bytes = vec![0u8; length as usize];
        file.seek(SeekFrom::Start(offset))
            .and_then(|_| file.read_exact(&mut bytes))
            .map_err(|error| read_failed(key, &error))?;
        Ok(bytes)
    }

    pub(crate) fn write_atomic(&self, key: &str, chunks: &[&[u8]]) -> Result<()> {
        let mut staged = self.create_staged(key)?;
        for chunk in chunks {
            staged.write_bytes(chunk)?;
        }
        let parent = staged.commit()?;
        self.sync_path(&parent)
    }

    fn settle_removal(&self, key: &str, parent: &Path, removal: io::Result<()>) -> Result<()> {
        match removal {
            Ok(()) => self.sync_path(parent),
            Err(error) if is_missing(&error) => Ok(()),
            Err(error) => Err(delete_failed(key, &error)),
        }
    }

    pub(crate) fn remove(&self, key: &str) -> Result<()> {
        let (path, parent) = self.parent_of(key)?;
        let removal = remove_file(&path);
        if removal.as_ref().map_or_else(is_missing, |()| true) {
            self.log_bytes.remove(key);
        }
        self.settle_removal(key, &parent, removal)
    }

    pub(crate) fn remove_tree(&self, prefix: &str) -> Result<()> {
        let key = prefix.trim_end_matches('/');
        let (path, parent) = self.parent_of(key)?;
        let removal = std::fs::remove_dir_all(&path);
        if removal.as_ref().map_or_else(is_missing, |()| true) {
            self.log_bytes.remove_tree(key);
        }
        self.settle_removal(key, &parent, removal)
    }

    pub(crate) fn rename(&self, from: &str, to: &str) -> Result<bool> {
        let (source, source_parent) = self.parent_of(from)?;
        let (target, target_parent) = self.ensure_parent(to)?;
        match rename_replacing(&source, &target) {
            Ok(()) => self.log_bytes.moved(from, to, || {
                std::fs::metadata(&target)
                    .ok()
                    .map(|metadata| metadata.len())
            }),
            Err(error) if is_missing(&error) => return Ok(false),
            Err(error) => {
                return Err(NarsilError::new(
                    ErrorCode::PERSISTENCE_SAVE_FAILED,
                    format!("Failed to move \"{from}\" to \"{to}\": {error}"),
                ));
            }
        }
        self.sync_path(&target_parent)?;
        if source_parent != target_parent {
            self.sync_path(&source_parent)?;
        }
        Ok(true)
    }

    pub(crate) fn list(&self, prefix: &str) -> Result<Vec<String>> {
        let directory_part = &prefix[..prefix.rfind('/').map_or(0, |at| at + 1)];
        let start = if directory_part.is_empty() {
            self.root.clone()
        } else {
            self.path_of(directory_part.trim_end_matches('/'))?
        };
        let mut keys = Vec::new();
        let base = if directory_part.is_empty() {
            String::new()
        } else {
            directory_part.to_string()
        };
        walk(&start, &base, &mut keys).map_err(|error| read_failed(prefix, &error))?;
        keys.retain(|key| key.starts_with(prefix));
        keys.sort();
        Ok(keys)
    }
}

fn walk(directory: &Path, base: &str, keys: &mut Vec<String>) -> io::Result<()> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if is_missing(&error) || error.kind() == io::ErrorKind::NotADirectory => {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) if is_missing(&error) => continue,
            Err(error) => return Err(error),
        };
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let key = format!("{base}{name}");
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) if is_missing(&error) => continue,
            Err(error) => return Err(error),
        };
        if file_type.is_dir() {
            walk(&entry.path(), &format!("{key}/"), keys)?;
        } else {
            keys.push(key);
        }
    }
    Ok(())
}
