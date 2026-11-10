use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};

use crate::error::Result;
use crate::format::wal::{
    COMMIT_MARKER_FILE_BYTES, COMMIT_MARKER_SLOT_BYTES, COMMIT_MARKER_SLOTS, CommitMarker,
    encode_marker_slot, read_commit_marker,
};

use super::files::{DurableDirectory, fsync_failed, read_failed, write_failed};
use super::platform::sync_file;

pub(crate) fn marker_key(index_name: &str, partition_id: u32) -> String {
    format!("{index_name}/wal/{partition_id}/commit")
}

pub(crate) struct MarkerFile {
    key: String,
    file: File,
    last_slot: Option<usize>,
    write_seq: u64,
    existing: Option<CommitMarker>,
}

impl MarkerFile {
    pub(crate) fn open(directory: &DurableDirectory, key: &str) -> Result<MarkerFile> {
        let (path, _) = directory.ensure_parent(key)?;
        let created = !path.exists();
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| write_failed(key, &error))?;
        let mut bytes = Vec::with_capacity(COMMIT_MARKER_FILE_BYTES);
        (&mut file)
            .take(COMMIT_MARKER_FILE_BYTES as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| read_failed(key, &error))?;
        let current = read_commit_marker(&bytes);
        if created {
            directory.sync_directory_of(key)?;
        }
        Ok(MarkerFile {
            key: key.to_string(),
            file,
            last_slot: current.map(|(_, slot)| slot),
            write_seq: current.map_or(0, |(state, _)| state.write_seq),
            existing: current.map(|(state, _)| state),
        })
    }

    pub(crate) fn existing(&self) -> Option<CommitMarker> {
        self.existing
    }

    pub(crate) fn commit(
        &mut self,
        active_segment_seq_no: u64,
        durable_byte_length: u64,
        highest_durable_seq_no: u64,
    ) -> Result<()> {
        let slot = self
            .last_slot
            .map_or(0, |last| (last + 1) % COMMIT_MARKER_SLOTS);
        let state = CommitMarker {
            write_seq: self.write_seq + 1,
            active_segment_seq_no,
            durable_byte_length,
            highest_durable_seq_no,
        };
        let bytes = encode_marker_slot(&state);
        let key = &self.key;
        self.file
            .seek(SeekFrom::Start((slot * COMMIT_MARKER_SLOT_BYTES) as u64))
            .and_then(|_| self.file.write_all(&bytes))
            .map_err(|error| write_failed(key, &error))?;
        sync_file(&self.file).map_err(|error| fsync_failed(key, &error))?;
        self.write_seq = state.write_seq;
        self.last_slot = Some(slot);
        self.existing = Some(state);
        Ok(())
    }
}
