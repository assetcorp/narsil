use std::io::{self, Read, Write};

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::archive_tar::{
    TAR_BLOCK_BYTES, invalid_archive, is_safe_integer, is_zero_block, parse_leading_integer,
    parse_pax_records, parse_tar_header, tar_end, tar_entry_headers, tar_padding,
};
use crate::format::envelope::{HEADER_BYTES, MAX_FILE_BYTES};
use crate::format::layout::SEGMENTS_MARKER;
use crate::format::manifest::{
    DecodedManifest, SegmentManifest, decode_manifest_payload, listed_keys, open_manifest_payload,
};
use crate::format::manifest_refs::FileRef;

pub(crate) const ARCHIVE_CONFIG_ENTRY: &str = "config";
pub(crate) const ARCHIVE_MANIFEST_ENTRY: &str = "manifest";
pub(crate) const QUERY_HISTORY_ARCHIVE_PREFIX: &str = "query-history/";
pub(crate) const MAX_HISTORY_FILE_BYTES: u64 = 16_777_216;
const MAX_PAX_HEADER_BYTES: u64 = 65_536;
const HEADER_CHECKSUM_OFFSET: usize = 14;

/// Receives the parts of a snapshot archive in the order that the archive holds them.
pub(crate) trait ArchiveSink {
    fn config(&mut self, bytes: Vec<u8>) -> Result<()>;
    fn manifest(
        &mut self,
        bytes: &[u8],
        manifest: &SegmentManifest,
        source_index_name: &str,
    ) -> Result<()>;
    fn file(&mut self, entry_name: &str, file: &FileRef, body: &mut dyn Read) -> Result<()>;
    fn history(&mut self, position: usize, body: &mut dyn Read) -> Result<()>;
}

struct EntryHeader {
    name: String,
    size: u64,
}

fn read_failure(error: io::Error, ends_inside: &str) -> NarsilError {
    if error.kind() == io::ErrorKind::UnexpectedEof {
        return invalid_archive(format!("the archive ends inside {ends_inside}"));
    }
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("The snapshot archive could not be read: {error}"),
    )
}

fn read_up_to(reader: &mut dyn Read, buffer: &mut [u8]) -> Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(read_failure(error, "an entry header")),
        }
    }
    Ok(filled)
}

fn read_block(reader: &mut dyn Read) -> Result<Option<[u8; TAR_BLOCK_BYTES]>> {
    let mut block = [0u8; TAR_BLOCK_BYTES];
    match read_up_to(reader, &mut block)? {
        0 => Ok(None),
        TAR_BLOCK_BYTES => Ok(Some(block)),
        _ => Err(invalid_archive("the archive ends inside an entry header")),
    }
}

fn skip_padding(reader: &mut dyn Read, size: u64) -> Result<()> {
    let padding = tar_padding(size).len();
    if padding == 0 {
        return Ok(());
    }
    let mut buffer = [0u8; TAR_BLOCK_BYTES];
    reader
        .read_exact(&mut buffer[..padding])
        .map_err(|error| read_failure(error, "the padding of an entry"))
}

fn read_padded(reader: &mut dyn Read, size: u64) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    let held = Read::take(&mut *reader, size)
        .read_to_end(&mut body)
        .map_err(|error| read_failure(error, "an entry"))?;
    if held as u64 != size {
        return Err(invalid_archive("the archive ends inside an entry"));
    }
    skip_padding(reader, size)?;
    Ok(body)
}

fn next_entry_header(reader: &mut dyn Read) -> Result<Option<EntryHeader>> {
    let Some(block) = read_block(reader)? else {
        return Ok(None);
    };
    if is_zero_block(&block) {
        return Ok(None);
    }
    let header = parse_tar_header(&block)?;
    if !header.is_pax_header {
        return Ok(Some(EntryHeader {
            name: header.name,
            size: header.size,
        }));
    }
    if header.size > MAX_PAX_HEADER_BYTES {
        return Err(invalid_archive("a pax extended header is too long"));
    }
    let records = parse_pax_records(&read_padded(reader, header.size)?)?;
    let next = match read_block(reader)? {
        Some(next) if !is_zero_block(&next) => next,
        _ => return Err(invalid_archive("a pax extended header precedes no entry")),
    };
    let entry = parse_tar_header(&next)?;
    if entry.is_pax_header {
        return Err(invalid_archive("a pax extended header follows another"));
    }
    let record = |key: &str| {
        records
            .iter()
            .find(|(held, _)| held == key)
            .map(|(_, value)| value.clone())
    };
    let size = match record("size") {
        None => entry.size,
        Some(text) => is_safe_integer(parse_leading_integer(&text))
            .ok_or_else(|| invalid_archive("a pax extended header holds an invalid size"))?,
    };
    Ok(Some(EntryHeader {
        name: record("path").unwrap_or(entry.name),
        size,
    }))
}

fn read_named_entry(reader: &mut dyn Read, expected: &str) -> Result<Vec<u8>> {
    let Some(header) = next_entry_header(reader)? else {
        return Err(invalid_archive(format!(
            "the archive ends before its {expected} entry"
        )));
    };
    if header.name != expected {
        return Err(invalid_archive(format!(
            "the archive holds \"{}\" where its {expected} entry belongs",
            header.name
        )));
    }
    if header.size > MAX_FILE_BYTES {
        return Err(invalid_archive(format!(
            "the {expected} entry passes the file size limit"
        )));
    }
    read_padded(reader, header.size)
}

/// Returns the index name that an archive's manifest keys start with.
pub(crate) fn archive_index_name(keys: &[String]) -> Result<String> {
    let Some(first) = keys.first() else {
        return Ok("archive".to_string());
    };
    match first.find(SEGMENTS_MARKER) {
        Some(at) if at > 0 => Ok(first[..at].to_string()),
        _ => Err(invalid_archive(format!(
            "the manifest lists the key \"{first}\" outside any index"
        ))),
    }
}

fn header_checksum_of(bytes: &[u8]) -> Option<u32> {
    if bytes.len() < HEADER_BYTES {
        return None;
    }
    let at = HEADER_CHECKSUM_OFFSET;
    Some(u32::from_be_bytes([
        bytes[at],
        bytes[at + 1],
        bytes[at + 2],
        bytes[at + 3],
    ]))
}

struct ExactBody<'a> {
    reader: &'a mut dyn Read,
    remaining: u64,
}

impl Read for ExactBody<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 || buffer.is_empty() {
            return Ok(0);
        }
        let wanted = buffer
            .len()
            .min(self.remaining.min(usize::MAX as u64) as usize);
        let count = self.reader.read(&mut buffer[..wanted])?;
        if count == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        self.remaining -= count as u64;
        Ok(count)
    }
}

fn hand_over_body(
    reader: &mut dyn Read,
    size: u64,
    deliver: impl FnOnce(&mut dyn Read) -> Result<()>,
) -> Result<()> {
    let mut body = ExactBody {
        reader,
        remaining: size,
    };
    deliver(&mut body)?;
    io::copy(&mut body, &mut io::sink()).map_err(|error| read_failure(error, "an entry"))?;
    skip_padding(body.reader, size)
}

fn listed_problem(name: &str, listed: &[String], seen: &[String]) -> String {
    let why = if !listed.iter().any(|entry| entry == name) {
        "that the manifest does not list"
    } else if seen.iter().any(|entry| entry == name) {
        "twice"
    } else {
        "out of order"
    };
    format!("the archive holds the entry \"{name}\" {why}")
}

/// Reads a snapshot archive with the checks of the reference reader, handing each part to `sink` as it arrives.
pub(crate) fn read_snapshot_archive(
    reader: &mut dyn Read,
    sink: &mut dyn ArchiveSink,
) -> Result<()> {
    sink.config(read_named_entry(reader, ARCHIVE_CONFIG_ENTRY)?)?;
    let manifest_bytes = read_named_entry(reader, ARCHIVE_MANIFEST_ENTRY)?;
    let (_, raw) = open_manifest_payload(&manifest_bytes)?;
    let source_index_name = archive_index_name(&listed_keys(&raw))?;
    let DecodedManifest::Current(manifest) = decode_manifest_payload(&raw, &source_index_name)?
    else {
        return Err(invalid_archive(
            "the manifest holds the layout of an earlier release",
        ));
    };
    sink.manifest(&manifest_bytes, &manifest, &source_index_name)?;
    let prefix = format!("{source_index_name}/");
    let files: Vec<FileRef> = manifest.file_refs().into_iter().cloned().collect();
    let listed: Vec<String> = files
        .iter()
        .map(|file| file.key[prefix.len()..].to_string())
        .collect();
    let mut seen: Vec<String> = Vec::with_capacity(files.len());
    for (file, expected) in files.iter().zip(&listed) {
        let Some(header) = next_entry_header(reader)? else {
            return Err(invalid_archive(format!(
                "the archive ends before it holds \"{expected}\""
            )));
        };
        if header.name != *expected {
            return Err(invalid_archive(listed_problem(
                &header.name,
                &listed,
                &seen,
            )));
        }
        if header.size != file.bytes {
            return Err(invalid_archive(format!(
                "the entry \"{expected}\" holds {} bytes where the manifest lists {}",
                header.size, file.bytes
            )));
        }
        let mut start = vec![0u8; HEADER_BYTES.min(header.size as usize)];
        reader
            .read_exact(&mut start)
            .map_err(|error| read_failure(error, "an entry"))?;
        if header_checksum_of(&start) != Some(file.checksum) {
            return Err(invalid_archive(format!(
                "the entry \"{expected}\" carries a checksum other than the manifest lists"
            )));
        }
        seen.push(expected.clone());
        let rest = header.size - start.len() as u64;
        let mut chained = io::Cursor::new(start).chain(ExactBody {
            reader: &mut *reader,
            remaining: rest,
        });
        sink.file(expected, file, &mut chained)?;
        io::copy(&mut chained, &mut io::sink()).map_err(|error| read_failure(error, "an entry"))?;
        skip_padding(reader, header.size)?;
    }
    read_history_entries(reader, sink)
}

fn read_history_entries(reader: &mut dyn Read, sink: &mut dyn ArchiveSink) -> Result<()> {
    for position in 0.. {
        let Some(header) = next_entry_header(reader)? else {
            return Ok(());
        };
        if header.name != format!("{QUERY_HISTORY_ARCHIVE_PREFIX}{position}") {
            return Err(invalid_archive(format!(
                "the archive holds the entry \"{}\" that the manifest does not list",
                header.name
            )));
        }
        if header.size > MAX_HISTORY_FILE_BYTES {
            return Err(invalid_archive(format!(
                "the entry \"{}\" passes the history file limit of {MAX_HISTORY_FILE_BYTES} bytes",
                header.name
            )));
        }
        hand_over_body(reader, header.size, |body| sink.history(position, body))?;
    }
    Ok(())
}

struct CountingWriter<'a> {
    out: &'a mut dyn Write,
    written: u64,
}

impl Write for CountingWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let count = self.out.write(bytes)?;
        self.written += count as u64;
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.out.flush()
    }
}

fn write_failure(error: io::Error) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!("The snapshot archive could not be written: {error}"),
    )
}

fn write_entry(out: &mut dyn Write, name: &str, bytes: &[u8]) -> Result<()> {
    out.write_all(&tar_entry_headers(name, bytes.len() as u64))
        .and_then(|()| out.write_all(bytes))
        .and_then(|()| out.write_all(&tar_padding(bytes.len() as u64)))
        .map_err(write_failure)
}

/// What a snapshot archive holds: the configuration, the manifest, and the history files after the listed files.
pub(crate) struct ArchiveSource<'a> {
    pub(crate) config: &'a [u8],
    pub(crate) manifest_bytes: &'a [u8],
    pub(crate) manifest: &'a SegmentManifest,
    pub(crate) source_index_name: &'a str,
    pub(crate) history: &'a dyn Fn() -> Result<Option<Vec<u8>>>,
}

/// Writes a snapshot archive, asking `copy_file` to write the bytes of each listed file in manifest order.
pub(crate) fn write_snapshot_archive(
    out: &mut dyn Write,
    source: &ArchiveSource<'_>,
    copy_file: &mut dyn FnMut(&FileRef, &mut dyn Write) -> Result<()>,
) -> Result<()> {
    write_entry(out, ARCHIVE_CONFIG_ENTRY, source.config)?;
    write_entry(out, ARCHIVE_MANIFEST_ENTRY, source.manifest_bytes)?;
    let prefix = format!("{}/", source.source_index_name);
    for file in source.manifest.file_refs() {
        let Some(name) = file.key.strip_prefix(&prefix) else {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!("The manifest lists \"{}\" outside the index", file.key),
            ));
        };
        out.write_all(&tar_entry_headers(name, file.bytes))
            .map_err(write_failure)?;
        let mut counting = CountingWriter {
            out: &mut *out,
            written: 0,
        };
        copy_file(file, &mut counting)?;
        if counting.written != file.bytes {
            return Err(NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!(
                    "The file \"{}\" holds {} bytes where the manifest lists {}",
                    file.key, counting.written, file.bytes
                ),
            ));
        }
        out.write_all(&tar_padding(file.bytes))
            .map_err(write_failure)?;
    }
    let mut position = 0;
    while let Some(history) = (source.history)()? {
        let name = format!("{QUERY_HISTORY_ARCHIVE_PREFIX}{position}");
        write_entry(out, &name, &history)?;
        position += 1;
    }
    out.write_all(&tar_end()).map_err(write_failure)
}
