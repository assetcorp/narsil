use std::io::Write;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::envelope::{
    Compression, HEADER_BYTES, read_header, require_within_file_limit, write_header,
};
use crate::format::manifest_refs::FileRef;

use super::checkpoint_store::FileSink;

pub(crate) struct EnvelopeSink {
    key: String,
    sink: FileSink,
    hasher: crc32fast::Hasher,
    version: u8,
    payload_bytes: u64,
}

impl EnvelopeSink {
    pub(crate) fn new(key: &str, mut sink: FileSink, version: u8) -> Result<EnvelopeSink> {
        sink.write_bytes(&[0u8; HEADER_BYTES])?;
        Ok(EnvelopeSink {
            key: key.to_string(),
            sink,
            hasher: crc32fast::Hasher::new(),
            version,
            payload_bytes: 0,
        })
    }

    pub(crate) fn write_payload(&mut self, bytes: &[u8]) -> Result<()> {
        require_within_file_limit(
            HEADER_BYTES as u64 + self.payload_bytes + bytes.len() as u64,
            &format!("file \"{}\"", self.key),
        )?;
        self.sink.write_bytes(bytes)?;
        self.hasher.update(bytes);
        self.payload_bytes += bytes.len() as u64;
        Ok(())
    }

    pub(crate) fn seal(mut self) -> Result<(FileSink, FileRef)> {
        let checksum = self.hasher.clone().finalize();
        let header = write_header(
            self.version,
            self.payload_bytes,
            Compression::None,
            Some(checksum),
        )?;
        self.sink.write_header_bytes(&header)?;
        let file = FileRef {
            key: self.key,
            bytes: self.sink.written(),
            checksum,
            head: None,
        };
        Ok((self.sink, file))
    }
}

impl Write for EnvelopeSink {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.write_payload(bytes)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(crate) fn packed_file_ref(key: &str, bytes: &[u8]) -> Result<FileRef> {
    let header = read_header(bytes)?;
    if !header.checksum_present {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_SAVE_FAILED,
            format!("The file \"{key}\" carries no checksum, which a checkpoint file requires"),
        ));
    }
    let expected = HEADER_BYTES as u64 + header.payload_length as u64;
    if bytes.len() as u64 != expected {
        return Err(NarsilError::new(
            ErrorCode::PERSISTENCE_SAVE_FAILED,
            format!(
                "The file \"{key}\" holds {} bytes where its header gives {expected}",
                bytes.len()
            ),
        ));
    }
    require_within_file_limit(bytes.len() as u64, &format!("file \"{key}\""))?;
    Ok(FileRef {
        key: key.to_string(),
        bytes: bytes.len() as u64,
        checksum: header.checksum,
        head: None,
    })
}
