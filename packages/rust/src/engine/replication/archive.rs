use std::io::{Read, Write};

use super::logged::CopyLog;
use super::replace::replace_documents;
use super::{CopyPosition, PartitionCopies};
use crate::engine::durable::checkpoint_locked;
use crate::engine::durable::partition_archive::partition_archive;
use crate::engine::durable::partition_receive::received_partition;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::archive::{ArchiveSource, write_snapshot_archive};
use crate::value::Value;

impl PartitionCopies<'_> {
    /// Writes the snapshot archive of one partition of a cluster copy to `out` and returns the position of the
    /// copy that the archive holds, as a primary sends it to a replica whose gap its log no longer covers.
    ///
    /// The archive holds the index configuration and a checkpoint that lists this partition alone and no graph
    /// part: one segment of its documents with each document's write record, the copy's term history, and one
    /// vector file per field with the vectors of this partition's documents alone. The engine builds the files in
    /// memory while it holds the index's write lock, so that every part describes the copy at the returned
    /// position, and it writes `out` once it lets the lock go.
    ///
    /// Fails with the partition's failure where the copy failed, with `CONFIG_INVALID` where the index is not a
    /// cluster copy or holds no such partition, and with `PERSISTENCE_SAVE_FAILED` where `out` refuses the bytes.
    pub fn archive_partition(
        &self,
        index: &str,
        partition: u32,
        out: &mut dyn Write,
    ) -> Result<CopyPosition> {
        let state = self.engine.open_index(index)?;
        let copy = super::copy_of(&state)?;
        let archive = partition_archive(&state, copy, partition)?;
        let checkpoint = &archive.checkpoint;
        let no_history = || Ok(None);
        let source = ArchiveSource {
            config: &archive.config,
            manifest_bytes: &checkpoint.manifest_bytes,
            manifest: &checkpoint.manifest,
            source_index_name: &state.name,
            history: &no_history,
        };
        let mut copy_file = |file: &_, sink: &mut dyn Write| checkpoint.copy_file(file, sink);
        write_snapshot_archive(out, &source, &mut copy_file)?;
        out.flush().map_err(|error| {
            NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!("The partition archive could not be written: {error}"),
            )
        })?;
        Ok(archive.position)
    }

    /// Replaces one partition of a cluster copy with the snapshot archive that the partition's primary sent, and
    /// numbers the copy's next entry after `position`, the position that the archive's header gives.
    ///
    /// The engine reads and checks every file of the archive, and decodes every document, before the partition
    /// changes, and the other partitions keep serving meanwhile. It then removes the partition's documents, vectors,
    /// log, and records, puts the archive's in their place, and saves the copy. Where the archive's terms came from
    /// another analysis revision, the index reports its analysis stale until it rebuilds its terms.
    ///
    /// Fails with `PERSISTENCE_LOAD_FAILED` where the archive is malformed or describes another partition, schema,
    /// analysis, or position, with `RESTORE_MEMORY_EXCEEDED` where its files would pass the process's memory limit,
    /// and with `CONFIG_INVALID` where the index is not a cluster copy. A failure after the partition changed leaves
    /// the partition failed.
    pub fn restore_partition(
        &self,
        index: &str,
        partition: u32,
        position: CopyPosition,
        archive: &mut dyn Read,
    ) -> Result<()> {
        let writable = self.engine.writable_index(index)?;
        let state = writable.index();
        drop(super::copy_of(state)?.partition(&state.name, partition)?);
        let received = received_partition(self.engine, state, partition, archive)?;
        if received.copy.position.seq_no != position.seq_no {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED,
                format!(
                    "The archive of partition {partition} of index \"{}\" holds sequence number {} where its header gives {}",
                    state.name, received.copy.position.seq_no, position.seq_no
                ),
            )
            .with_details([
                ("indexName", Value::from(state.name.as_str())),
                ("partitionId", Value::from(partition)),
            ]));
        }
        {
            let _writer = state.lock_writes()?;
            let copy = super::copy_of(state)?;
            let log = CopyLog::of(state, partition);
            let mut restored = received.copy;
            restored.position = position;
            log.discard()
                .and_then(|()| replace_documents(state, partition, received.documents))
                .and_then(|()| {
                    *copy.partition(&state.name, partition)? = restored;
                    log.restart_after(position)
                })
                .and_then(|()| checkpoint_locked(state))
                .inspect_err(|failure| log.fail(failure))?;
            if received.analysis_stale {
                state.set_analysis_stale(true);
            }
        }
        self.engine.memory.memory_released();
        self.engine.events.wrote(&state.name);
        Ok(())
    }
}
