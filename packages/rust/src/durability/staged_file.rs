use std::fs::{File, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{ErrorCode, NarsilError, Result};

use super::files::{TEMPORARY_MARK, fsync_failed, write_failed};
use super::platform::{remove_file, rename_replacing, sync_file};

static TEMPORARY_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) struct StagedFile {
    key: String,
    file: Option<File>,
    temporary: PathBuf,
    target: PathBuf,
    parent: PathBuf,
    written: u64,
}

impl StagedFile {
    pub(crate) fn create(key: &str, target: PathBuf, parent: PathBuf) -> Result<StagedFile> {
        let name = target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let temporary = parent.join(format!(
            "{name}{TEMPORARY_MARK}{}-{}",
            std::process::id(),
            TEMPORARY_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)
            .map_err(|error| write_failed(key, &error))?;
        Ok(StagedFile {
            key: key.to_string(),
            file: Some(file),
            temporary,
            target,
            parent,
            written: 0,
        })
    }

    pub(crate) fn written(&self) -> u64 {
        self.written
    }

    fn handle(&mut self) -> Result<&mut File> {
        let key = self.key.clone();
        self.file.as_mut().ok_or_else(|| {
            NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!("The file \"{key}\" is already closed"),
            )
        })
    }

    pub(crate) fn write_bytes(&mut self, bytes: &[u8]) -> Result<()> {
        let key = self.key.clone();
        self.handle()?
            .write_all(bytes)
            .map_err(|error| write_failed(&key, &error))?;
        self.written += bytes.len() as u64;
        Ok(())
    }

    pub(crate) fn write_at_start(&mut self, bytes: &[u8]) -> Result<()> {
        let key = self.key.clone();
        let file = self.handle()?;
        file.seek(SeekFrom::Start(0))
            .and_then(|_| file.write_all(bytes))
            .and_then(|_| file.seek(SeekFrom::End(0)).map(|_| ()))
            .map_err(|error| write_failed(&key, &error))
    }

    pub(crate) fn commit(mut self) -> Result<PathBuf> {
        let key = self.key.clone();
        let synced = self
            .handle()?
            .flush()
            .map_err(|error| write_failed(&key, &error))
            .and_then(|_| {
                self.handle()
                    .and_then(|file| sync_file(file).map_err(|error| fsync_failed(&key, &error)))
            });
        synced?;
        self.file = None;
        if let Err(error) = rename_replacing(&self.temporary, &self.target) {
            let _ = remove_file(&self.temporary);
            return Err(write_failed(&key, &error));
        }
        Ok(self.parent.clone())
    }
}

impl Write for StagedFile {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("the file is already closed"))?;
        let written = file.write(bytes)?;
        self.written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.file.as_mut() {
            Some(file) => file.flush(),
            None => Ok(()),
        }
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if self.file.take().is_some() {
            let _ = remove_file(&self.temporary);
        }
    }
}
