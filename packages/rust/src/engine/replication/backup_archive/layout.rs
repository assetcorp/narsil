use super::spooled::BackupFileReader;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::archive::{ARCHIVE_CONFIG_ENTRY, ARCHIVE_MANIFEST_ENTRY};
use crate::format::archive_tar::{tar_end, tar_entry_headers, tar_padding};

enum PartSource {
    Bytes(Vec<u8>),
    File(usize),
}

pub(super) struct ArchivePart {
    start: u64,
    length: u64,
    source: PartSource,
}

fn push_bytes(parts: &mut Vec<ArchivePart>, at: &mut u64, bytes: Vec<u8>) {
    if bytes.is_empty() {
        return;
    }
    let length = bytes.len() as u64;
    if let Some(ArchivePart {
        length: last_length,
        source: PartSource::Bytes(last),
        ..
    }) = parts.last_mut()
    {
        last.extend_from_slice(&bytes);
        *last_length += length;
    } else {
        parts.push(ArchivePart {
            start: *at,
            length,
            source: PartSource::Bytes(bytes),
        });
    }
    *at += length;
}

fn entry_bytes(name: &str, bytes: &[u8]) -> Vec<u8> {
    let mut out = tar_entry_headers(name, bytes.len() as u64);
    out.extend_from_slice(bytes);
    out.extend_from_slice(&tar_padding(bytes.len() as u64));
    out
}

pub(super) fn archive_parts(
    config: &[u8],
    manifest_bytes: &[u8],
    entries: &[(String, u64)],
) -> (Vec<ArchivePart>, u64) {
    let mut parts = Vec::new();
    let mut at = 0u64;
    push_bytes(
        &mut parts,
        &mut at,
        entry_bytes(ARCHIVE_CONFIG_ENTRY, config),
    );
    push_bytes(
        &mut parts,
        &mut at,
        entry_bytes(ARCHIVE_MANIFEST_ENTRY, manifest_bytes),
    );
    for (position, (name, bytes)) in entries.iter().enumerate() {
        push_bytes(&mut parts, &mut at, tar_entry_headers(name, *bytes));
        if *bytes > 0 {
            parts.push(ArchivePart {
                start: at,
                length: *bytes,
                source: PartSource::File(position),
            });
            at += bytes;
        }
        push_bytes(&mut parts, &mut at, tar_padding(*bytes));
    }
    push_bytes(&mut parts, &mut at, tar_end());
    (parts, at)
}

pub(super) fn read_parts(
    parts: &[ArchivePart],
    offset: u64,
    buffer: &mut [u8],
    read: &BackupFileReader,
) -> Result<usize> {
    let mut copied = 0usize;
    let mut at = offset;
    let first = parts.partition_point(|part| part.start + part.length <= at);
    for part in &parts[first..] {
        if copied == buffer.len() {
            break;
        }
        let within = at - part.start;
        let take = (part.length - within).min((buffer.len() - copied) as u64) as usize;
        let target = &mut buffer[copied..copied + take];
        match &part.source {
            PartSource::Bytes(bytes) => {
                target.copy_from_slice(&bytes[within as usize..within as usize + take]);
            }
            PartSource::File(position) => {
                let piece = read(*position, within, take as u64)?;
                if piece.len() != take {
                    return Err(NarsilError::new(
                        ErrorCode::PERSISTENCE_LOAD_FAILED,
                        format!(
                            "A spooled backup file at position {position} is shorter than the backup lists"
                        ),
                    ));
                }
                target.copy_from_slice(&piece);
            }
        }
        copied += take;
        at += take as u64;
    }
    Ok(copied)
}
