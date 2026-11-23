use std::collections::HashMap;
use std::hash::Hash;

use narsil::Value;
use narsil::replication::CopyPosition;
use tokio::io::AsyncReadExt;

use crate::constants::{
    DEFAULT_MAX_PER_SOURCE_SNAPSHOTS, DEFAULT_MAX_STREAMS_PER_INDEX, MAX_SOURCE_ID_LENGTH,
    SNAPSHOT_CHUNK_SIZE,
};
use crate::controller::lock;
use crate::data::snapshot_spool::{SpoolWriter, SpooledSnapshot};
use crate::data::writes::PrimaryWrites;
use crate::data::writes::partition::Partition;
use crate::error::{ClusterError, ClusterResult, codes};
use crate::message::{TransportMessage, message_types};
use crate::payload::snapshot::{
    SnapshotHeader, encode_snapshot_chunk, encode_snapshot_end, encode_snapshot_start,
};
use crate::payload::sync::SyncRequest;
use crate::transport::Respond;

/// How many snapshots this primary builds for each replica and index, and streams for each index, at once.
#[derive(Default)]
pub(in crate::data::writes) struct SnapshotSlots {
    per_source: HashMap<(String, String), usize>,
    streams: HashMap<String, usize>,
}

enum Slot {
    Source(String, String),
    Stream(String),
}

struct HeldSlot<'a> {
    writes: &'a PrimaryWrites,
    slot: Slot,
}

fn release<K: Eq + Hash>(counts: &mut HashMap<K, usize>, key: K) {
    match counts.get(&key).copied() {
        Some(count) if count > 1 => {
            counts.insert(key, count - 1);
        }
        _ => {
            counts.remove(&key);
        }
    }
}

impl Drop for HeldSlot<'_> {
    fn drop(&mut self) {
        let mut slots = lock(&self.writes.snapshot_slots);
        match &self.slot {
            Slot::Source(source, index) => {
                release(&mut slots.per_source, (source.clone(), index.clone()));
            }
            Slot::Stream(index) => release(&mut slots.streams, index.clone()),
        }
    }
}

fn contains_control_character(value: &str) -> bool {
    value.chars().any(|character| {
        let code = character as u32;
        code < 0x20
            || (0x7f..=0x9f).contains(&code)
            || code == 0x2028
            || code == 0x2029
            || code == 0xfeff
    })
}

fn source_id_problem(source_id: &str) -> Option<String> {
    if source_id.is_empty() {
        return Some("request sourceId is missing".to_string());
    }
    if source_id.encode_utf16().count() > MAX_SOURCE_ID_LENGTH {
        return Some(format!(
            "request sourceId exceeds {MAX_SOURCE_ID_LENGTH} characters"
        ));
    }
    if contains_control_character(source_id) {
        return Some("request sourceId contains control characters".to_string());
    }
    None
}

fn capacity_exhausted(message: String, details: [(&str, Value); 2]) -> ClusterError {
    details.into_iter().fold(
        ClusterError::new(codes::SNAPSHOT_SYNC_CAPACITY_EXHAUSTED, message),
        |error, (key, value)| error.with_detail(key, value),
    )
}

fn snapshot_failed(error: ClusterError) -> ClusterError {
    if error.code() != codes::SNAPSHOT_SYNC_RESTORE_FAILED {
        return error;
    }
    ClusterError::new(codes::SNAPSHOT_SYNC_SNAPSHOT_FAILED, error.message())
}

impl PrimaryWrites {
    fn hold_source_slot(&self, source_id: &str, index_name: &str) -> ClusterResult<HeldSlot<'_>> {
        let key = (source_id.to_string(), index_name.to_string());
        let mut slots = lock(&self.snapshot_slots);
        let current = slots.per_source.get(&key).copied().unwrap_or(0);
        if current >= DEFAULT_MAX_PER_SOURCE_SNAPSHOTS {
            return Err(capacity_exhausted(
                format!(
                    "snapshot producer per-source cap reached for '{source_id}' index '{index_name}'"
                ),
                [
                    ("sourceId", Value::from(source_id)),
                    ("indexName", Value::from(index_name)),
                ],
            ));
        }
        slots.per_source.insert(key.clone(), current + 1);
        Ok(HeldSlot {
            writes: self,
            slot: Slot::Source(key.0, key.1),
        })
    }

    fn hold_stream_slot(&self, index_name: &str) -> ClusterResult<HeldSlot<'_>> {
        let mut slots = lock(&self.snapshot_slots);
        let current = slots.streams.get(index_name).copied().unwrap_or(0);
        if current >= DEFAULT_MAX_STREAMS_PER_INDEX {
            return Err(capacity_exhausted(
                format!("snapshot stream fan-out cap reached for index '{index_name}'"),
                [
                    ("indexName", Value::from(index_name)),
                    ("cap", Value::from(DEFAULT_MAX_STREAMS_PER_INDEX as u64)),
                ],
            ));
        }
        slots.streams.insert(index_name.to_string(), current + 1);
        Ok(HeldSlot {
            writes: self,
            slot: Slot::Stream(index_name.to_string()),
        })
    }

    async fn build_snapshot(
        &self,
        request: &SyncRequest,
    ) -> ClusterResult<(CopyPosition, SpooledSnapshot)> {
        let (name, partition_id) = (request.index_name.clone(), request.partition_id);
        let directory = self.spool_directory.clone();
        self.on_copies(move |copies| {
            let mut spool = SpoolWriter::create(&directory)?;
            let position = copies.archive_partition(&name, partition_id, &mut spool)?;
            Ok((position, spool.finish()?))
        })
        .await
        .map_err(snapshot_failed)
    }

    async fn stream_snapshot(
        &self,
        message: &TransportMessage,
        respond: &Respond,
        request: &SyncRequest,
        header: &SnapshotHeader,
        archive: &SpooledSnapshot,
        sync_session: &str,
    ) -> ClusterResult<()> {
        let reply = |message_type: &str, payload: Vec<u8>| {
            TransportMessage::new(
                message_type,
                self.node_id.as_str(),
                message.request_id.as_str(),
                payload,
            )
        };
        let start = encode_snapshot_start(header, archive.total_bytes, sync_session);
        respond
            .send(reply(message_types::REPLICATION_SNAPSHOT_START, start))
            .await;
        let unreadable = |error: std::io::Error| {
            ClusterError::new(
                codes::SNAPSHOT_SYNC_SNAPSHOT_FAILED,
                format!("the snapshot could not be read back from local storage: {error}"),
            )
        };
        let mut file = tokio::fs::File::open(&archive.path)
            .await
            .map_err(unreadable)?;
        let mut buffer = vec![0u8; SNAPSHOT_CHUNK_SIZE];
        let mut offset = 0u64;
        loop {
            let mut filled = 0;
            while filled < buffer.len() {
                let read = file.read(&mut buffer[filled..]).await.map_err(unreadable)?;
                if read == 0 {
                    break;
                }
                filled += read;
            }
            if filled == 0 {
                break;
            }
            let chunk = encode_snapshot_chunk(
                &request.index_name,
                request.partition_id,
                offset,
                &buffer[..filled],
            );
            respond
                .send(reply(message_types::REPLICATION_SNAPSHOT_CHUNK, chunk))
                .await;
            offset += filled as u64;
        }
        if offset != archive.total_bytes {
            return Err(ClusterError::new(
                codes::SNAPSHOT_SYNC_SNAPSHOT_FAILED,
                format!(
                    "the snapshot holds {offset} bytes on disk where the spool wrote {}",
                    archive.total_bytes
                ),
            ));
        }
        let end = encode_snapshot_end(
            &request.index_name,
            request.partition_id,
            archive.total_bytes,
            header.checksum,
        );
        respond
            .send(reply(message_types::REPLICATION_SNAPSHOT_END, end))
            .await;
        Ok(())
    }

    /// Answers a sync request whose gap the log no longer covers: builds the partition's archive in a spool file,
    /// streams it as `replication.snapshot_start`, `replication.snapshot_chunk`, and `replication.snapshot_end`,
    /// then sends the entries that the log holds after the archive's position.
    pub(super) async fn send_snapshot(
        &self,
        message: &TransportMessage,
        respond: &Respond,
        partition: &Partition,
        request: &SyncRequest,
        sync_session: &str,
    ) -> ClusterResult<()> {
        if let Some(problem) = source_id_problem(&message.source_id) {
            return Err(ClusterError::new(
                codes::SNAPSHOT_SYNC_REQUEST_INVALID,
                problem,
            ));
        }
        let _source = self.hold_source_slot(&message.source_id, &request.index_name)?;
        let (position, archive) = self.build_snapshot(request).await?;
        let _stream = self.hold_stream_slot(&request.index_name)?;
        let header = SnapshotHeader {
            last_seq_no: position.seq_no,
            primary_term: position.primary_term,
            partition_id: request.partition_id,
            index_name: request.index_name.clone(),
            checksum: u64::from(archive.checksum),
        };
        self.stream_snapshot(message, respond, request, &header, &archive, sync_session)
            .await?;
        drop(archive);
        let log_end = lock(&partition.log)
            .newest_seq_no()
            .unwrap_or(position.seq_no)
            .max(position.seq_no);
        let span = (position.seq_no + 1, log_end);
        self.send_sync_entries(message, respond, partition, request, span, sync_session)
            .await
    }
}
