mod constants;
mod tasks;

use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use narsil::{AdapterError, ErrorCode, NarsilError, PersistenceAdapter};

use constants::{MAX_RECORD_BYTES, STAGED_SUFFIX_BYTES};
pub use tasks::reconcile_local_tasks;

pub struct RecordFolder {
    directory: PathBuf,
}

fn refusal(message: impl Into<String>) -> AdapterError {
    Box::new(NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        message,
    ))
}

fn require_filename(key: &str) -> Result<(), AdapterError> {
    let plain = !key.is_empty() && key != "." && key != ".." && !key.contains(['/', '\\', '\0']);
    if plain {
        Ok(())
    } else {
        Err(refusal("A record key must be a filename"))
    }
}

fn staged_name(key: &str) -> Result<String, AdapterError> {
    let mut suffix = [0u8; STAGED_SUFFIX_BYTES];
    getrandom::fill(&mut suffix).map_err(|_| refusal("The system offers no random numbers"))?;
    let hex: String = suffix.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(".{key}.{hex}.staged"))
}

fn sync_directory(directory: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        File::open(directory)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
        Ok(())
    }
}

#[cfg(unix)]
fn same_file(opened: &std::fs::Metadata, linked: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    opened.dev() == linked.dev() && opened.ino() == linked.ino()
}

#[cfg(not(unix))]
fn same_file(opened: &std::fs::Metadata, linked: &std::fs::Metadata) -> bool {
    opened.len() == linked.len()
}

impl RecordFolder {
    pub fn new(directory: PathBuf) -> RecordFolder {
        RecordFolder { directory }
    }

    fn read_regular_file(&self, path: &Path) -> std::io::Result<Option<Vec<u8>>> {
        let linked = match std::fs::symlink_metadata(path) {
            Ok(linked) => linked,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if !linked.file_type().is_file() || linked.len() > MAX_RECORD_BYTES {
            return Ok(None);
        }
        let mut file = File::open(path)?;
        let opened = file.metadata()?;
        if !opened.is_file() || !same_file(&opened, &linked) || opened.len() > MAX_RECORD_BYTES {
            return Ok(None);
        }
        let mut bytes = Vec::with_capacity(usize::try_from(opened.len()).unwrap_or(0));
        (&mut file)
            .take(MAX_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Ok(None);
        }
        Ok(Some(bytes))
    }
}

impl PersistenceAdapter for RecordFolder {
    fn save(&self, key: &str, data: &[u8]) -> Result<(), AdapterError> {
        require_filename(key)?;
        let staged = self.directory.join(staged_name(key)?);
        let written = (|| -> std::io::Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged)?;
            file.write_all(data)?;
            file.sync_all()?;
            std::fs::rename(&staged, self.directory.join(key))?;
            sync_directory(&self.directory)
        })();
        if let Err(error) = written {
            let _ = std::fs::remove_file(&staged);
            return Err(refusal(format!("Failed to save the record {key}: {error}")));
        }
        Ok(())
    }

    fn load(&self, key: &str) -> Result<Option<Vec<u8>>, AdapterError> {
        require_filename(key)?;
        self.read_regular_file(&self.directory.join(key))
            .map_err(|error| -> AdapterError {
                Box::new(NarsilError::new(
                    ErrorCode::PERSISTENCE_LOAD_FAILED,
                    format!("Failed to load the record {key}: {error}"),
                ))
            })
    }

    fn delete(&self, key: &str) -> Result<(), AdapterError> {
        require_filename(key)?;
        match std::fs::remove_file(self.directory.join(key)) {
            Ok(()) => sync_directory(&self.directory)
                .map_err(|error| refusal(format!("Failed to delete the record {key}: {error}"))),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(refusal(format!(
                "Failed to delete the record {key}: {error}"
            ))),
        }
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>, AdapterError> {
        let entries = std::fs::read_dir(&self.directory).map_err(|error| -> AdapterError {
            Box::new(NarsilError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED,
                format!("Failed to list the records: {error}"),
            ))
        })?;
        let mut keys = Vec::new();
        for entry in entries.flatten() {
            let is_directory = entry.file_type().is_ok_and(|kind| kind.is_dir());
            if let (false, Ok(name)) = (is_directory, entry.file_name().into_string())
                && name.starts_with(prefix)
            {
                keys.push(name);
            }
        }
        keys.sort();
        Ok(keys)
    }
}
