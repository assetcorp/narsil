use std::path::PathBuf;
use std::sync::Arc;

use crate::adapters::AdapterError;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{Expectation, MAX_FILE_BYTES, open_checksummed};
use crate::format::manifest_refs::FileRef;

use super::files::{DurableDirectory, range_outside};
use super::persistence::PersistenceAdapter;
use super::staged_file::StagedFile;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileLength {
    Known(u64),
    Missing,
    Unknown,
}

pub(crate) enum FileSink {
    Staged(StagedFile),
    Buffered { key: String, bytes: Vec<u8> },
}

impl FileSink {
    pub(crate) fn written(&self) -> u64 {
        match self {
            FileSink::Staged(staged) => staged.written(),
            FileSink::Buffered { bytes, .. } => bytes.len() as u64,
        }
    }

    pub(crate) fn write_bytes(&mut self, bytes: &[u8]) -> Result<()> {
        match self {
            FileSink::Staged(staged) => staged.write_bytes(bytes),
            FileSink::Buffered { bytes: buffer, .. } => {
                buffer.extend_from_slice(bytes);
                Ok(())
            }
        }
    }

    pub(crate) fn write_header_bytes(&mut self, header: &[u8]) -> Result<()> {
        match self {
            FileSink::Staged(staged) => staged.write_at_start(header),
            FileSink::Buffered { bytes, .. } => {
                let end = header.len().min(bytes.len());
                bytes[..end].copy_from_slice(&header[..end]);
                Ok(())
            }
        }
    }
}

pub(crate) trait CheckpointStore: Send + Sync {
    fn read_within(&self, key: &str, limit: u64) -> Result<Option<Vec<u8>>>;
    fn read_range(&self, key: &str, offset: u64, length: u64) -> Result<Vec<u8>>;
    fn length(&self, key: &str) -> Result<FileLength>;
    fn begin_file(&self, key: &str) -> Result<FileSink>;
    fn finish_file(&self, sink: FileSink) -> Result<Option<PathBuf>>;
    fn sync_directories(&self, directories: &[PathBuf]) -> Result<()>;
    fn write_commit(&self, key: &str, bytes: &[u8]) -> Result<()>;
    fn remove(&self, key: &str) -> Result<()>;
    fn list(&self, prefix: &str) -> Result<Vec<String>>;
}

impl CheckpointStore for DurableDirectory {
    fn read_within(&self, key: &str, limit: u64) -> Result<Option<Vec<u8>>> {
        DurableDirectory::read_within(self, key, limit)
    }

    fn read_range(&self, key: &str, offset: u64, length: u64) -> Result<Vec<u8>> {
        DurableDirectory::read_range(self, key, offset, length)
    }

    fn length(&self, key: &str) -> Result<FileLength> {
        Ok(match self.byte_length(key)? {
            Some(length) => FileLength::Known(length),
            None => FileLength::Missing,
        })
    }

    fn begin_file(&self, key: &str) -> Result<FileSink> {
        Ok(FileSink::Staged(self.create_staged(key)?))
    }

    fn finish_file(&self, sink: FileSink) -> Result<Option<PathBuf>> {
        match sink {
            FileSink::Staged(staged) => staged.commit().map(Some),
            FileSink::Buffered { key, bytes } => {
                self.write_atomic(&key, &[&bytes])?;
                Ok(None)
            }
        }
    }

    fn sync_directories(&self, directories: &[PathBuf]) -> Result<()> {
        for directory in directories {
            self.sync_path(directory)?;
        }
        Ok(())
    }

    fn write_commit(&self, key: &str, bytes: &[u8]) -> Result<()> {
        self.write_atomic(key, &[bytes])
    }

    fn remove(&self, key: &str) -> Result<()> {
        DurableDirectory::remove(self, key)
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>> {
        DurableDirectory::list(self, prefix)
    }
}

pub(crate) struct AdapterStore {
    adapter: Arc<dyn PersistenceAdapter>,
}

impl AdapterStore {
    pub(crate) fn new(adapter: Arc<dyn PersistenceAdapter>) -> AdapterStore {
        AdapterStore { adapter }
    }
}

fn adapter_failure(code: ErrorCode, verb: &str, key: &str, error: AdapterError) -> NarsilError {
    match error.downcast::<NarsilError>() {
        Ok(error) => *error,
        Err(error) => NarsilError::new(
            code,
            format!("The persistence adapter failed to {verb} \"{key}\": {error}"),
        ),
    }
}

impl CheckpointStore for AdapterStore {
    fn read_within(&self, key: &str, limit: u64) -> Result<Option<Vec<u8>>> {
        let bytes = self.adapter.load(key).map_err(|error| {
            adapter_failure(ErrorCode::PERSISTENCE_LOAD_FAILED, "load", key, error)
        })?;
        match bytes {
            Some(bytes) if bytes.len() as u64 > limit => Err(NarsilError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED,
                format!(
                    "\"{key}\" holds {} bytes, above the limit of {limit} bytes",
                    bytes.len()
                ),
            )),
            other => Ok(other),
        }
    }

    fn read_range(&self, key: &str, offset: u64, length: u64) -> Result<Vec<u8>> {
        let bytes = self
            .read_within(key, MAX_FILE_BYTES)?
            .ok_or_else(|| range_outside(key))?;
        let range = usize::try_from(offset).ok().and_then(|start| {
            let end = start.checked_add(usize::try_from(length).ok()?)?;
            bytes.get(start..end)
        });
        range.map(<[u8]>::to_vec).ok_or_else(|| range_outside(key))
    }

    fn length(&self, _key: &str) -> Result<FileLength> {
        Ok(FileLength::Unknown)
    }

    fn begin_file(&self, key: &str) -> Result<FileSink> {
        Ok(FileSink::Buffered {
            key: key.to_string(),
            bytes: Vec::new(),
        })
    }

    fn finish_file(&self, sink: FileSink) -> Result<Option<PathBuf>> {
        let (key, bytes) = match sink {
            FileSink::Buffered { key, bytes } => (key, bytes),
            FileSink::Staged(_) => {
                return Err(NarsilError::new(
                    ErrorCode::PERSISTENCE_SAVE_FAILED,
                    "A persistence adapter received a file staged in a directory",
                ));
            }
        };
        self.write_commit(&key, &bytes)?;
        Ok(None)
    }

    fn sync_directories(&self, _directories: &[PathBuf]) -> Result<()> {
        Ok(())
    }

    fn write_commit(&self, key: &str, bytes: &[u8]) -> Result<()> {
        self.adapter.save(key, bytes).map_err(|error| {
            adapter_failure(ErrorCode::PERSISTENCE_SAVE_FAILED, "save", key, error)
        })
    }

    fn remove(&self, key: &str) -> Result<()> {
        self.adapter.delete(key).map_err(|error| {
            adapter_failure(ErrorCode::PERSISTENCE_DELETE_FAILED, "delete", key, error)
        })
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>> {
        let mut keys = self.adapter.list(prefix).map_err(|error| {
            adapter_failure(ErrorCode::PERSISTENCE_LOAD_FAILED, "list", prefix, error)
        })?;
        keys.retain(|key| key.starts_with(prefix));
        keys.sort();
        keys.dedup();
        Ok(keys)
    }
}

fn missing_file(what: &str, key: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("The {what} \"{key}\" that the manifest lists is missing"),
    )
}

fn listed_length_differs(what: &str, key: &str, found: u64, listed: u64) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("The {what} \"{key}\" holds {found} bytes where the manifest lists {listed}"),
    )
}

pub(crate) fn require_listed_length(
    store: &dyn CheckpointStore,
    file: &FileRef,
    what: &str,
) -> Result<()> {
    match store.length(&file.key)? {
        FileLength::Missing => Err(missing_file(what, &file.key)),
        FileLength::Known(found) if found != file.bytes => {
            Err(listed_length_differs(what, &file.key, found, file.bytes))
        }
        _ => Ok(()),
    }
}

pub(crate) fn read_listed_file(
    store: &dyn CheckpointStore,
    file: &FileRef,
    what: &str,
) -> Result<Vec<u8>> {
    require_listed_length(store, file, what)?;
    let limit = file.bytes.min(MAX_FILE_BYTES);
    let bytes = match store.read_within(&file.key, limit) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(missing_file(what, &file.key)),
        Err(error) if error.code() == ErrorCode::PERSISTENCE_LOAD_FAILED => {
            return Err(match store.length(&file.key)? {
                FileLength::Known(found) => {
                    listed_length_differs(what, &file.key, found, file.bytes)
                }
                _ => error,
            });
        }
        Err(error) => return Err(error),
    };
    if bytes.len() as u64 != file.bytes {
        return Err(listed_length_differs(
            what,
            &file.key,
            bytes.len() as u64,
            file.bytes,
        ));
    }
    Ok(bytes)
}

pub(crate) fn require_listed_checksum(
    what: &str,
    key: &str,
    found: u32,
    listed: u32,
) -> Result<()> {
    if found == listed {
        return Ok(());
    }
    Err(NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("The {what} \"{key}\" carries checksum {found} where the manifest lists {listed}"),
    ))
}

pub(crate) fn read_listed_payload(
    store: &dyn CheckpointStore,
    file: &FileRef,
    what: &str,
    version: u8,
    allows_compression: bool,
) -> Result<Vec<u8>> {
    let bytes = read_listed_file(store, file, what)?;
    let described = format!("{what} \"{}\"", file.key);
    let expectation = Expectation {
        version,
        what: &described,
        allows_compression,
    };
    let (header, payload) = open_checksummed(&bytes, &expectation)?;
    require_listed_checksum(what, &file.key, header.checksum, file.checksum)?;
    Ok(payload.bytes().to_vec())
}
