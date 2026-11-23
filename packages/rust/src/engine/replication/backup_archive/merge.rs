use std::collections::HashMap;

use super::layout::archive_parts;
use super::{BackupArchive, BackupArchiveFile};
use crate::engine::replication::backup::{
    BackupListedFile, BackupPartitionFiles, read_partition_manifest,
};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::Compression;
use crate::format::layout::{segment_key, vector_file_key};
use crate::format::manifest::{SegmentManifest, encode_manifest};
use crate::format::manifest_refs::{FileRef, VectorFieldRef, VectorFileRef};
use crate::value::Value;

/// One partition of a backup as [`BackupArchive::merge`] takes it: the stored segment manifest and the files that
/// the backup lists for it.
pub struct BackupArchivePartition<'a> {
    /// The partition's ID.
    pub partition_id: u32,
    /// The partition's segment manifest, as the backup stores it.
    pub manifest: &'a [u8],
    /// Every file that the backup lists for the partition, in the manifest's order.
    pub files: &'a [BackupListedFile],
    /// The sequence number that the backup lists for the partition.
    pub last_seq_no: u64,
}

struct FieldPart {
    field: VectorFieldRef,
    partition: usize,
    listed: Vec<usize>,
}

fn damaged(backup_name: &str, reason: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::BACKUP_DAMAGED,
        format!("Backup '{backup_name}' {reason}, so a device can't load it"),
    )
    .with_details([("backupName", Value::from(backup_name))])
}

fn listed_position(
    backup_name: &str,
    files: &[BackupListedFile],
    source_index_name: &str,
    key: &str,
) -> Result<usize> {
    files
        .iter()
        .position(|file| format!("{source_index_name}/{}", file.key) == key)
        .ok_or_else(|| damaged(backup_name, &format!("lists no file for \"{key}\"")))
}

impl BackupArchive {
    /// Returns the snapshot of a backup whose partitions `partitions` lists, with `config` as its index
    /// configuration payload: one segment manifest that lists the segments of every partition under the index
    /// name of the first partition, and each vector field's files renumbered across the partitions.
    ///
    /// # Errors
    ///
    /// Fails with `BACKUP_DAMAGED` where a partition's manifest is unreadable or disagrees with the files and the
    /// position that the backup lists, or where the backup holds no partition.
    pub fn merge(
        backup_name: &str,
        config: Vec<u8>,
        partitions: &[BackupArchivePartition<'_>],
    ) -> Result<BackupArchive> {
        let mut first: Option<(String, SegmentManifest)> = None;
        let mut merged_partitions = Vec::new();
        let mut checkpoint = Vec::new();
        let mut fields: Vec<(String, Vec<FieldPart>)> = Vec::new();
        let mut sources: HashMap<String, BackupArchiveFile> = HashMap::new();
        for (at, partition) in partitions.iter().enumerate() {
            let read = read_partition_manifest(
                &BackupPartitionFiles {
                    backup_name,
                    config: &config,
                    manifest: partition.manifest,
                    files: partition.files,
                    last_seq_no: partition.last_seq_no,
                },
                partition.partition_id,
            )?;
            let source = read.source_index_name.as_str();
            let name = first
                .as_ref()
                .map_or(source, |(name, _)| name.as_str())
                .to_string();
            let listed = |key: &str| listed_position(backup_name, partition.files, source, key);
            for mut entry in read.manifest.partitions.clone() {
                for segment in &mut entry.segments {
                    let key = segment_key(&name, entry.partition_id, segment.id);
                    let file = BackupArchiveFile {
                        partition: at,
                        listed: listed(&segment.file.key)?,
                        bytes: segment.file.bytes,
                    };
                    sources.insert(key.clone(), file);
                    segment.file.key = key;
                }
                merged_partitions.push(entry);
            }
            checkpoint.extend(read.manifest.checkpoint.iter().cloned());
            for field in &read.manifest.vectors {
                let positions = field
                    .files
                    .iter()
                    .map(|file| listed(&file.file.key))
                    .collect::<Result<Vec<usize>>>()?;
                let part = FieldPart {
                    field: field.clone(),
                    partition: at,
                    listed: positions,
                };
                match fields
                    .iter_mut()
                    .find(|(path, _)| *path == field.field_path)
                {
                    Some((_, parts)) => parts.push(part),
                    None => fields.push((field.field_path.clone(), vec![part])),
                }
            }
            if first.is_none() {
                first = Some((read.source_index_name.clone(), read.manifest));
            }
        }
        let Some((name, first_manifest)) = first else {
            return Err(damaged(backup_name, "holds no partition"));
        };
        let mut vectors = Vec::with_capacity(fields.len());
        for (field_path, parts) in fields {
            let mut merged = VectorFieldRef {
                field_path: field_path.clone(),
                next_file_id: 0,
                files: Vec::new(),
                graph_generation: 0,
                graph_parts: Vec::new(),
            };
            for part in parts {
                for (file, listed) in part.field.files.iter().zip(&part.listed) {
                    let id = merged.next_file_id;
                    merged.next_file_id += 1;
                    let key = vector_file_key(&name, &field_path, id)?;
                    sources.insert(
                        key.clone(),
                        BackupArchiveFile {
                            partition: part.partition,
                            listed: *listed,
                            bytes: file.file.bytes,
                        },
                    );
                    merged.files.push(VectorFileRef {
                        id,
                        file: FileRef {
                            key,
                            ..file.file.clone()
                        },
                        ..file.clone()
                    });
                }
            }
            vectors.push(merged);
        }
        let manifest = SegmentManifest {
            schema: first_manifest.schema,
            language: first_manifest.language,
            analysis_generation: first_manifest.analysis_generation,
            checkpoint,
            partitions: merged_partitions,
            vectors,
        };
        let manifest_bytes = encode_manifest(&manifest, Compression::None)?;
        let prefix = format!("{name}/");
        let mut keys = Vec::new();
        let mut files = Vec::new();
        let mut entries = Vec::new();
        for file in manifest.file_refs() {
            let Some(source) = sources.get(&file.key) else {
                return Err(damaged(
                    backup_name,
                    &format!("lost the file \"{}\"", file.key),
                ));
            };
            let entry_name = file.key.strip_prefix(&prefix).unwrap_or(&file.key);
            entries.push((entry_name.to_string(), file.bytes));
            keys.push(file.key.clone());
            files.push(*source);
        }
        let (parts, length) = archive_parts(&config, &manifest_bytes, &entries);
        Ok(BackupArchive {
            config,
            manifest_bytes,
            manifest,
            keys,
            files,
            parts,
            length,
        })
    }
}
