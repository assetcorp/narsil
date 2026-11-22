use crate::error::{ClusterError, codes};
use crate::payload::sync::{SyncBatch, SyncFrame, decode_sync_frame};

#[derive(Default)]
pub(super) struct SyncFrames {
    pub(super) batches: Vec<SyncBatch>,
    pub(super) sync_session: Option<String>,
    pub(super) saw_snapshot: bool,
    pub(super) error: Option<ClusterError>,
}

fn frame_invalid(message: &str) -> ClusterError {
    ClusterError::new(codes::SNAPSHOT_SYNC_FRAME_INVALID, message)
}

impl SyncFrames {
    pub(super) fn take(&mut self, frame: &[u8]) -> bool {
        match decode_sync_frame(frame) {
            Err(error) => self.error = Some(error),
            Ok(SyncFrame::Snapshot) if !self.batches.is_empty() => {
                self.error = Some(frame_invalid(
                    "received snapshot frame after incremental sync_entries",
                ));
            }
            Ok(SyncFrame::Snapshot) => self.saw_snapshot = true,
            Ok(SyncFrame::Entries { .. }) if self.batches.iter().any(|batch| batch.is_last) => {
                self.error = Some(frame_invalid(
                    "sync_entries marked isLast before final batch",
                ));
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
        }
        self.error.is_none() && !self.saw_snapshot
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
