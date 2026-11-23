use std::path::PathBuf;

use super::snapshot_stream::SnapshotStream;
use crate::error::{ClusterError, codes};
use crate::payload::sync::{SyncBatch, SyncFrame, decode_sync_frame};

pub(super) struct SyncFrames {
    pub(super) batches: Vec<SyncBatch>,
    pub(super) sync_session: Option<String>,
    pub(super) saw_snapshot: bool,
    pub(super) snapshot: SnapshotStream,
    pub(super) error: Option<ClusterError>,
}

fn frame_invalid(message: &str) -> ClusterError {
    ClusterError::new(codes::SNAPSHOT_SYNC_FRAME_INVALID, message)
}

impl SyncFrames {
    pub(super) fn new(index_name: &str, partition_id: u32, spool_directory: PathBuf) -> Self {
        SyncFrames {
            batches: Vec::new(),
            sync_session: None,
            saw_snapshot: false,
            snapshot: SnapshotStream::new(index_name, partition_id, spool_directory),
            error: None,
        }
    }

    pub(super) fn stopped(index_name: &str, partition_id: u32) -> Self {
        let mut frames = SyncFrames::new(index_name, partition_id, PathBuf::new());
        frames.error = Some(frame_invalid("the replica stopped reading the sync answer"));
        frames
    }

    pub(super) fn take(&mut self, frame: &[u8]) -> bool {
        if self.error.is_some() {
            return false;
        }
        let after_last = self.batches.last().is_some_and(|batch| batch.is_last);
        match decode_sync_frame(frame) {
            Err(error) => self.error = Some(error),
            Ok(_) if after_last => {
                self.error = Some(frame_invalid(
                    "received a sync payload after the sync_entries batch marked isLast",
                ));
            }
            Ok(SyncFrame::Entries { .. }) if self.saw_snapshot && !self.snapshot.ended() => {
                self.error = Some(frame_invalid("received sync_entries before snapshot_end"));
            }
            Ok(SyncFrame::Entries {
                entries,
                is_last,
                sync_session,
            }) => {
                if self.notes_session(sync_session) {
                    self.batches.push(SyncBatch { entries, is_last });
                }
            }
            Ok(SyncFrame::Snapshot) if !self.batches.is_empty() && !self.saw_snapshot => {
                self.error = Some(frame_invalid(
                    "received snapshot frame after incremental sync_entries",
                ));
            }
            Ok(SyncFrame::Snapshot) => {
                self.saw_snapshot = true;
                self.snapshot.take(frame);
                if let Some(failure) = &self.snapshot.failure {
                    self.error = Some(failure.clone());
                } else {
                    let session = self.snapshot.sync_session.clone();
                    self.notes_session(session);
                }
            }
        }
        self.error.is_none()
    }

    fn notes_session(&mut self, sync_session: Option<String>) -> bool {
        let Some(sync_session) = sync_session else {
            return true;
        };
        match &self.sync_session {
            None => {
                self.sync_session = Some(sync_session);
                true
            }
            Some(held) if *held == sync_session => true,
            Some(_) => {
                self.error = Some(frame_invalid(
                    "one sync answer carried two different sync sessions",
                ));
                false
            }
        }
    }

    pub(super) fn check_termination(&self) -> Result<(), ClusterError> {
        let Some((last, earlier)) = self.batches.split_last() else {
            return Ok(());
        };
        if earlier.iter().any(|batch| batch.is_last) {
            return Err(frame_invalid(
                "sync_entries marked isLast before final batch",
            ));
        }
        if !last.is_last {
            return Err(frame_invalid(
                "live sync stream ended before final sync_entries batch",
            ));
        }
        Ok(())
    }
}
