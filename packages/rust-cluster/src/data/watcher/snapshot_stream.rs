use std::path::PathBuf;

use narsil::Value;

use crate::constants::{MAX_SAFE_INTEGER, SNAPSHOT_CHUNK_SIZE};
use crate::data::snapshot_spool::{SpoolWriter, SpooledSnapshot};
use crate::error::{ClusterError, ClusterResult, codes};
use crate::payload::snapshot::{
    SnapshotHeader, SnapshotPart, decode_snapshot_part, decode_snapshot_start,
};

/// The snapshot part of one sync answer, which a replica writes to a spool file chunk by chunk as it arrives.
pub(super) struct SnapshotStream {
    index_name: String,
    partition_id: u32,
    spool_directory: PathBuf,
    first_frame_seen: bool,
    header: Option<SnapshotHeader>,
    total_bytes: Option<u64>,
    spool: Option<SpoolWriter>,
    accumulated_bytes: u64,
    expected_next_offset: u64,
    end_seen: bool,
    pub(super) failure: Option<ClusterError>,
    pub(super) sync_session: Option<String>,
}

fn safe(value: Option<u64>) -> Option<u64> {
    value.filter(|value| *value <= MAX_SAFE_INTEGER)
}

impl SnapshotStream {
    pub(super) fn new(index_name: &str, partition_id: u32, spool_directory: PathBuf) -> Self {
        SnapshotStream {
            index_name: index_name.to_string(),
            partition_id,
            spool_directory,
            first_frame_seen: false,
            header: None,
            total_bytes: None,
            spool: None,
            accumulated_bytes: 0,
            expected_next_offset: 0,
            end_seen: false,
            failure: None,
            sync_session: None,
        }
    }

    pub(super) fn ended(&self) -> bool {
        self.end_seen
    }

    fn fail(&mut self, code: &str, message: &str) {
        self.fail_with(ClusterError::new(code, message));
    }

    fn fail_with(&mut self, error: ClusterError) {
        if self.failure.is_none() {
            self.failure = Some(error);
        }
        self.spool = None;
    }

    pub(super) fn take(&mut self, frame: &[u8]) {
        if self.failure.is_some() {
            return;
        }
        if !self.first_frame_seen {
            self.first_frame_seen = true;
            self.apply_start(frame);
            return;
        }
        match decode_snapshot_part(frame) {
            SnapshotPart::Chunk {
                partition_id,
                index_name,
                offset,
                data,
            } => self.apply_chunk(partition_id, index_name, offset, data),
            SnapshotPart::End {
                partition_id,
                index_name,
                total_bytes,
                checksum,
            } => self.apply_end(partition_id, index_name, total_bytes, checksum),
            SnapshotPart::Unknown => self.fail(
                codes::SNAPSHOT_SYNC_FRAME_INVALID,
                "unrecognised snapshot frame shape",
            ),
        }
    }

    fn apply_start(&mut self, frame: &[u8]) {
        let start = decode_snapshot_start(frame);
        let invalid = codes::SNAPSHOT_SYNC_HEADER_INVALID;
        let Some(header) = start.header.filter(|_| start.header_shaped) else {
            if start.header_shaped {
                self.fail(
                    invalid,
                    "the snapshot header holds a value that is not a non-negative integer",
                );
            } else {
                self.fail(invalid, "expected SNAPSHOT_START as first frame");
            }
            return;
        };
        if header.index_name != self.index_name {
            self.fail_with(
                ClusterError::new(
                    codes::SNAPSHOT_SYNC_HEADER_MISMATCH,
                    "snapshot header indexName mismatch",
                )
                .with_detail("expected", Value::String(self.index_name.clone()))
                .with_detail("received", Value::String(header.index_name)),
            );
            return;
        }
        if header.partition_id != self.partition_id {
            self.fail_with(
                ClusterError::new(
                    codes::SNAPSHOT_SYNC_HEADER_MISMATCH,
                    "snapshot header partitionId mismatch",
                )
                .with_detail("expected", Value::from(self.partition_id))
                .with_detail("received", Value::from(header.partition_id)),
            );
            return;
        }
        let Some(total_bytes) = safe(start.total_bytes) else {
            self.fail(invalid, "totalBytes must be a non-negative integer");
            return;
        };
        let Some(sync_session) = start.sync_session else {
            self.fail(invalid, "syncSession must be a non-empty string or absent");
            return;
        };
        match SpoolWriter::create(&self.spool_directory) {
            Ok(spool) => self.spool = Some(spool),
            Err(error) => {
                self.fail_with(error);
                return;
            }
        }
        self.header = Some(header);
        self.total_bytes = Some(total_bytes);
        self.sync_session = sync_session;
    }

    fn apply_chunk(
        &mut self,
        partition_id: Option<u64>,
        index_name: &str,
        offset: Option<u64>,
        data: Option<&[u8]>,
    ) {
        let (Some(header), Some(total_bytes)) = (&self.header, self.total_bytes) else {
            self.fail(
                codes::SNAPSHOT_SYNC_FRAME_INVALID,
                "received chunk before SNAPSHOT_START",
            );
            return;
        };
        let Some(offset) = safe(offset) else {
            self.fail(
                codes::SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER,
                "chunk offset must be a non-negative integer",
            );
            return;
        };
        let mismatch = codes::SNAPSHOT_SYNC_HEADER_MISMATCH;
        let Some(partition_id) = safe(partition_id) else {
            self.fail(mismatch, "chunk partitionId must be a non-negative integer");
            return;
        };
        if index_name != header.index_name {
            self.fail(mismatch, "chunk indexName does not match header");
            return;
        }
        if partition_id != u64::from(header.partition_id) {
            self.fail(mismatch, "chunk partitionId does not match header");
            return;
        }
        if offset != self.expected_next_offset {
            let expected = self.expected_next_offset;
            self.fail_with(
                ClusterError::new(
                    codes::SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER,
                    "chunk arrived out of order",
                )
                .with_detail("expected", Value::from(expected))
                .with_detail("received", Value::from(offset)),
            );
            return;
        }
        let Some(data) = data else {
            self.fail(
                codes::SNAPSHOT_SYNC_FRAME_INVALID,
                "chunk data is not binary",
            );
            return;
        };
        let remaining = total_bytes - self.accumulated_bytes;
        let limit = (SNAPSHOT_CHUNK_SIZE as u64).min(remaining);
        let length = data.len() as u64;
        if length > limit {
            self.fail_with(
                ClusterError::new(
                    codes::SNAPSHOT_SYNC_CHUNK_SIZE_EXCEEDED,
                    "chunk exceeds the per-chunk size limit",
                )
                .with_detail("chunkBytes", Value::from(length))
                .with_detail("limit", Value::from(limit)),
            );
            return;
        }
        let Some(spool) = self.spool.as_mut() else {
            self.fail(
                codes::SNAPSHOT_SYNC_FRAME_INVALID,
                "received chunk after the snapshot stream closed",
            );
            return;
        };
        if let Err(error) = spool.append(data) {
            self.fail_with(error);
            return;
        }
        self.accumulated_bytes += length;
        self.expected_next_offset = offset + length;
    }

    fn apply_end(
        &mut self,
        partition_id: Option<u64>,
        index_name: &str,
        total_bytes: Option<u64>,
        checksum: Option<u64>,
    ) {
        let (Some(header), Some(expected_total)) = (&self.header, self.total_bytes) else {
            self.fail(
                codes::SNAPSHOT_SYNC_FRAME_INVALID,
                "received SNAPSHOT_END before SNAPSHOT_START",
            );
            return;
        };
        let mismatch = codes::SNAPSHOT_SYNC_HEADER_MISMATCH;
        if index_name != header.index_name {
            self.fail(mismatch, "end indexName does not match header");
            return;
        }
        if partition_id != Some(u64::from(header.partition_id)) {
            self.fail(mismatch, "end partitionId does not match header");
            return;
        }
        if safe(total_bytes) != Some(expected_total) {
            self.fail(mismatch, "end totalBytes does not match SNAPSHOT_START");
            return;
        }
        if safe(checksum) != Some(header.checksum) {
            self.fail(
                codes::SNAPSHOT_SYNC_CHECKSUM_MISMATCH,
                "end checksum does not match header",
            );
            return;
        }
        self.end_seen = true;
    }

    /// Returns the header and the whole archive once the answer ended, after checking that every byte arrived and
    /// that the bytes carry the header's checksum.
    pub(super) fn finish(&mut self) -> ClusterResult<(SnapshotHeader, SpooledSnapshot)> {
        if let Some(failure) = self.failure.clone() {
            return Err(failure);
        }
        let (Some(header), Some(total_bytes)) = (self.header.clone(), self.total_bytes) else {
            return Err(ClusterError::new(
                codes::SNAPSHOT_SYNC_CHUNK_MISSING,
                "stream ended before SNAPSHOT_START was received",
            ));
        };
        let received = Value::from(self.accumulated_bytes);
        if !self.end_seen {
            return Err(ClusterError::new(
                codes::SNAPSHOT_SYNC_END_MISSING,
                "stream ended without SNAPSHOT_END",
            )
            .with_detail("receivedBytes", received)
            .with_detail("totalBytes", Value::from(total_bytes)));
        }
        if self.accumulated_bytes != total_bytes {
            return Err(ClusterError::new(
                codes::SNAPSHOT_SYNC_CHUNK_MISSING,
                "stream ended with byte count mismatch",
            )
            .with_detail("receivedBytes", received)
            .with_detail("totalBytes", Value::from(total_bytes)));
        }
        let Some(spool) = self.spool.take() else {
            return Err(ClusterError::new(
                codes::SNAPSHOT_SYNC_FRAME_INVALID,
                "the snapshot stream was already settled",
            ));
        };
        let computed = spool.checksum();
        if u64::from(computed) != header.checksum {
            return Err(ClusterError::new(
                codes::SNAPSHOT_SYNC_CHECKSUM_MISMATCH,
                "computed checksum does not match header checksum",
            )
            .with_detail("computed", Value::from(computed))
            .with_detail("header", Value::from(header.checksum)));
        }
        Ok((header, spool.finish()?))
    }
}
