use std::io::{self, Read};
use std::sync::Arc;

use super::archive::{current_metadata, index_configuration};
use super::build::recovered_index;
use super::load::{grow_partitions, load_partition};
use super::load_source::StagedSource;
use super::reload::{attach_checkpoint_vectors, reserve_segment_memory};
use crate::durability::checkpoint_store::{AdapterStore, CheckpointStore};
use crate::durability::persistence::MemoryPersistence;
use crate::engine::EngineInner;
use crate::engine::durable::constants::ARCHIVE_COPY_CHUNK_BYTES;
use crate::engine::index::IndexState;
use crate::engine::memory::require_restore_memory;
use crate::engine::replication::copy_state::{PartitionCopy, ReplicatedCopy};
use crate::engine::restore::validate::validate_staged_checkpoint;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::archive::{ArchiveSink, read_snapshot_archive};
use crate::format::index_configuration::decode_index_configuration;
use crate::format::manifest::SegmentManifest;
use crate::format::manifest_refs::FileRef;
use crate::schema::flatten_schema;
use crate::value::{Map, Value};

const ANALYSIS_KEYS: [&str; 3] = ["language", "tokenizer", "stopWords"];
const STOP_WORD_LIST_KEY: &str = "stopWordList";
const ANALYSIS_REVISION_KEY: &str = "analysisRevision";

/// One partition as the archive that a primary sent holds it, ready to replace the copy's partition.
pub(crate) struct ReceivedPartition {
    pub(crate) documents: Vec<(String, Map)>,
    pub(crate) copy: PartitionCopy,
    pub(crate) analysis_stale: bool,
}

fn refused(index: &IndexState, partition: u32, why: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!(
            "The archive of partition {partition} of index \"{}\" cannot replace the copy, because {why}",
            index.name
        ),
    )
    .with_details([
        ("indexName", Value::from(index.name.as_str())),
        ("partitionId", Value::from(partition)),
    ])
}

fn sorted_words(value: Option<&Value>) -> Option<Vec<String>> {
    let Value::Array(items) = value? else {
        return None;
    };
    let mut words: Vec<String> = items
        .iter()
        .filter_map(|item| match item {
            Value::String(word) => Some(word.clone()),
            _ => None,
        })
        .collect();
    words.sort();
    Some(words)
}

struct ReceiveSink<'a> {
    index: &'a IndexState,
    partition: u32,
    local: &'a Map,
    store: &'a AdapterStore,
    received_revision: Option<Option<String>>,
    manifest: Option<SegmentManifest>,
    buffer: Vec<u8>,
}

impl ReceiveSink<'_> {
    fn copy_body(&mut self, key: &str, body: &mut dyn Read) -> Result<()> {
        if self.buffer.is_empty() {
            self.buffer = vec![0u8; ARCHIVE_COPY_CHUNK_BYTES as usize];
        }
        let mut sink = self.store.begin_file(key)?;
        loop {
            let count = match body.read(&mut self.buffer) {
                Ok(0) => break,
                Ok(count) => count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    return Err(NarsilError::new(
                        ErrorCode::PERSISTENCE_LOAD_FAILED,
                        format!("The partition archive could not be read: {error}"),
                    ));
                }
            };
            sink.write_bytes(&self.buffer[..count])?;
        }
        self.store.finish_file(sink)?;
        Ok(())
    }
}

impl ArchiveSink for ReceiveSink<'_> {
    fn config(&mut self, bytes: Vec<u8>) -> Result<()> {
        let (_, payload) = decode_index_configuration(&bytes)?;
        let same_analysis = ANALYSIS_KEYS
            .iter()
            .all(|key| payload.get(key) == self.local.get(key))
            && sorted_words(payload.get(STOP_WORD_LIST_KEY))
                == sorted_words(self.local.get(STOP_WORD_LIST_KEY));
        if !same_analysis {
            return Err(refused(
                self.index,
                self.partition,
                "it holds terms from other analysis settings, so the copy tries again",
            ));
        }
        let revision = match payload.get(ANALYSIS_REVISION_KEY) {
            Some(Value::String(revision)) => Some(revision.clone()),
            _ => None,
        };
        self.received_revision = Some(revision);
        Ok(())
    }

    fn manifest(
        &mut self,
        _bytes: &[u8],
        manifest: &SegmentManifest,
        source_index_name: &str,
    ) -> Result<()> {
        if self.received_revision.is_none() {
            return Err(refused(
                self.index,
                self.partition,
                "it holds no configuration",
            ));
        }
        let listed: Vec<u32> = manifest
            .partitions
            .iter()
            .map(|entry| entry.partition_id)
            .collect();
        if listed != [self.partition] {
            return Err(refused(
                self.index,
                self.partition,
                "it lists other partitions",
            ));
        }
        if manifest
            .vectors
            .iter()
            .any(|field| !field.graph_parts.is_empty())
        {
            return Err(refused(self.index, self.partition, "it holds a graph"));
        }
        let local_schema = self
            .index
            .config()
            .schema
            .as_object()
            .map(flatten_schema)
            .unwrap_or_default();
        if local_schema != manifest.schema {
            return Err(refused(
                self.index,
                self.partition,
                "its schema differs from the copy's schema",
            ));
        }
        let mut renamed = manifest.clone();
        let rename = |key: &mut String| {
            let tail = key.get(source_index_name.len() + 1..).unwrap_or_default();
            *key = format!("{}/{tail}", self.index.name);
        };
        for entry in &mut renamed.partitions {
            for segment in &mut entry.segments {
                rename(&mut segment.file.key);
            }
        }
        for field in &mut renamed.vectors {
            for file in &mut field.files {
                rename(&mut file.file.key);
            }
        }
        self.manifest = Some(renamed);
        Ok(())
    }

    fn file(&mut self, entry_name: &str, file: &FileRef, body: &mut dyn Read) -> Result<()> {
        if self.manifest.is_none() {
            return Err(refused(self.index, self.partition, "it holds no manifest"));
        }
        require_restore_memory(&self.index.name, file.bytes, false)?;
        let key = format!("{}/{entry_name}", self.index.name);
        self.copy_body(&key, body)
    }

    fn history(&mut self, _position: usize, _body: &mut dyn Read) -> Result<()> {
        Err(refused(
            self.index,
            self.partition,
            "it holds query history",
        ))
    }
}

/// Reads the archive of `partition` that a primary sent for the cluster copy `index`, checks every file of it,
/// and decodes the partition's documents, vectors, write records, and term history, leaving the copy as it stands.
///
/// Fails with `PERSISTENCE_LOAD_FAILED` where the archive is malformed, lists another partition or a graph, holds
/// another schema or other analysis settings than the copy, and with `RESTORE_MEMORY_EXCEEDED` where its files
/// would pass the process's memory limit.
pub(crate) fn received_partition(
    engine: &EngineInner,
    index: &IndexState,
    partition: u32,
    archive: &mut dyn Read,
) -> Result<ReceivedPartition> {
    let metadata = current_metadata(index);
    let local = index_configuration(index, &metadata)?;
    let store = AdapterStore::new(Arc::new(MemoryPersistence::new()));
    let mut sink = ReceiveSink {
        index,
        partition,
        local: &local,
        store: &store,
        received_revision: None,
        manifest: None,
        buffer: Vec::new(),
    };
    read_snapshot_archive(archive, &mut sink)?;
    let received_revision = sink.received_revision.take().flatten();
    let manifest = sink
        .manifest
        .take()
        .ok_or_else(|| refused(index, partition, "it holds no manifest"))?;
    let source = StagedSource::Memory(&store);
    validate_staged_checkpoint(&source, &manifest)?;
    let stored = recovered_index(engine, &metadata)?;
    let partition_count = index.partitions().len();
    grow_partitions(&stored, partition_count, std::iter::once(partition))?;
    if let Some(entry) = manifest.partitions.first() {
        reserve_segment_memory(&source, &engine.memory, &stored, entry)?;
        load_partition(&source, &stored, entry, &manifest.schema)?;
    }
    let copy = ReplicatedCopy::loaded(&stored, String::new(), None, &manifest.checkpoint)?;
    let partitions = stored.partitions();
    let Some(held) = partitions.get(partition as usize) else {
        return Err(refused(index, partition, "the copy lacks the partition"));
    };
    let snapshot = held.snapshot();
    let mut documents = Vec::new();
    {
        let mut records = copy.partition(&index.name, partition)?;
        for entry in &snapshot.segments {
            for ordinal in entry.live_ordinals() {
                let id = entry.id_of(ordinal)?.into_owned();
                let Some(document) = stored.full_document(&id)? else {
                    return Err(refused(index, partition, "a stored document is missing"));
                };
                records.hold_saved(&id, entry, ordinal)?;
                documents.push((id, document));
            }
        }
    }
    attach_checkpoint_vectors(
        &source,
        &engine.memory,
        &stored,
        partition,
        &manifest,
        &mut documents,
    )?;
    let copy = copy.partition(&index.name, partition)?.clone();
    let current_revision = index.analyser().language().revision().to_string();
    Ok(ReceivedPartition {
        documents,
        copy,
        analysis_stale: received_revision.as_deref() != Some(current_revision.as_str()),
    })
}
