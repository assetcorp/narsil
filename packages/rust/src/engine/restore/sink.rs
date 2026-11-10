use std::io::{self, Read};
use std::path::PathBuf;

use super::prepare::{PreparedIndex, archive_rejection, prepare_restored_index};
use crate::durability::checkpoint_store::CheckpointStore;
use crate::engine::EngineInner;
use crate::engine::durable::constants::ARCHIVE_COPY_CHUNK_BYTES;
use crate::engine::query_suggestions::restored_history::RestoredHistory;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::archive::ArchiveSink;
use crate::format::archive_tar::invalid_archive;
use crate::format::index_configuration::decode_index_configuration;
use crate::format::manifest::SegmentManifest;
use crate::format::manifest_refs::FileRef;
use crate::schema::flatten_schema;

/// Receives a snapshot archive's parts for one restore: builds the index that its configuration describes,
/// checks its manifest against that configuration, and writes each listed file into the restore's staging store.
pub(super) struct StagingSink<'a> {
    engine: &'a EngineInner,
    index_name: &'a str,
    store: &'a dyn CheckpointStore,
    prepared: Option<PreparedIndex>,
    manifest: Option<SegmentManifest>,
    directories: Vec<PathBuf>,
    buffer: Vec<u8>,
    history: Option<RestoredHistory>,
    history_opened: bool,
}

fn missing_part(what: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("The archive holds no {what}"),
    )
}

fn require_same_schema(prepared: &PreparedIndex, manifest: &SegmentManifest) -> Result<()> {
    let config = prepared.index.config();
    let configured = config
        .schema
        .as_object()
        .map(flatten_schema)
        .unwrap_or_default();
    let fields = configured.keys().chain(manifest.schema.keys());
    for field in fields {
        if configured.get(field) == manifest.schema.get(field) {
            continue;
        }
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_LOAD_FAILED,
            format!(
                "The archive's configuration gives field \"{field}\" another type than its manifest does"
            ),
        ));
    }
    Ok(())
}

fn renamed_key(key: &mut String, source_index_name: &str, index_name: &str) {
    let tail = key.get(source_index_name.len() + 1..).unwrap_or_default();
    *key = format!("{index_name}/{tail}");
}

fn renamed(
    manifest: &SegmentManifest,
    source_index_name: &str,
    index_name: &str,
) -> SegmentManifest {
    let mut manifest = manifest.clone();
    let rename = |key: &mut String| renamed_key(key, source_index_name, index_name);
    for partition in &mut manifest.partitions {
        for segment in &mut partition.segments {
            rename(&mut segment.file.key);
        }
    }
    for field in &mut manifest.vectors {
        for file in &mut field.files {
            rename(&mut file.file.key);
        }
        for part in &mut field.graph_parts {
            rename(&mut part.key);
        }
    }
    manifest
}

fn body_failure(error: io::Error) -> NarsilError {
    if error.kind() == io::ErrorKind::UnexpectedEof {
        return invalid_archive("the archive ends inside an entry");
    }
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("The snapshot archive could not be read: {error}"),
    )
}

impl<'a> StagingSink<'a> {
    pub(super) fn new(
        engine: &'a EngineInner,
        index_name: &'a str,
        store: &'a dyn CheckpointStore,
    ) -> StagingSink<'a> {
        StagingSink {
            engine,
            index_name,
            store,
            prepared: None,
            manifest: None,
            directories: Vec::new(),
            buffer: Vec::new(),
            history: None,
            history_opened: false,
        }
    }

    /// Returns the index and the manifest that the archive described, with the query history that it carried,
    /// once every file is in the staging store and every directory that holds one is synced.
    pub(super) fn finish(
        self,
    ) -> Result<(PreparedIndex, SegmentManifest, Option<RestoredHistory>)> {
        let prepared = self.prepared.ok_or_else(|| missing_part("configuration"))?;
        let manifest = self.manifest.ok_or_else(|| missing_part("manifest"))?;
        self.store.sync_directories(&self.directories)?;
        Ok((prepared, manifest, self.history))
    }

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
                Err(error) => return Err(body_failure(error)),
            };
            sink.write_bytes(&self.buffer[..count])?;
        }
        if let Some(directory) = self.store.finish_file(sink)?
            && !self.directories.contains(&directory)
        {
            self.directories.push(directory);
        }
        Ok(())
    }
}

impl ArchiveSink for StagingSink<'_> {
    fn config(&mut self, bytes: Vec<u8>) -> Result<()> {
        let (_, payload) = decode_index_configuration(&bytes)?;
        let prepared =
            prepare_restored_index(self.engine, self.index_name, &payload, &archive_rejection)?;
        self.prepared = Some(prepared);
        Ok(())
    }

    fn manifest(
        &mut self,
        _bytes: &[u8],
        manifest: &SegmentManifest,
        source_index_name: &str,
    ) -> Result<()> {
        let prepared = self
            .prepared
            .as_ref()
            .ok_or_else(|| missing_part("configuration"))?;
        require_same_schema(prepared, manifest)?;
        self.manifest = Some(renamed(manifest, source_index_name, self.index_name));
        Ok(())
    }

    fn file(&mut self, entry_name: &str, _file: &FileRef, body: &mut dyn Read) -> Result<()> {
        if self.manifest.is_none() {
            return Err(missing_part("manifest"));
        }
        let key = format!("{}/{entry_name}", self.index_name);
        self.copy_body(&key, body)
    }

    fn history(&mut self, _position: usize, body: &mut dyn Read) -> Result<()> {
        if !self.history_opened {
            self.history_opened = true;
            if let Some(prepared) = &self.prepared {
                let restored = prepared.index.suggestion_state();
                self.history = RestoredHistory::open(self.engine, self.index_name, &restored)?;
            }
        }
        match self.history.as_mut() {
            Some(history) => history.add(body),
            None => Ok(()),
        }
    }
}
