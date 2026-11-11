use crate::error::{ErrorCode, NarsilError, Result};
use crate::format::manifest_refs::Head;
use crate::util::hash::crc32;
use crate::value::{write_array_header, write_binary, write_map_header, write_string, write_uint};

pub(crate) const SEGMENT_PAGE_BYTES: usize = 65_536;
pub(crate) const RECORD_PAGE_BYTES: usize = 16_384;
const STABLE_HEAD_ATTEMPTS: usize = 8;
const SECTION_KEYS: usize = 5;

/// One run of bytes in a payload that a reader can page in, with a CRC-32 for every page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileSection {
    pub(crate) name: &'static str,
    pub(crate) offset: usize,
    pub(crate) length: usize,
    pub(crate) page_bytes: usize,
    pub(crate) checksums: Vec<u8>,
}

pub(crate) fn page_checksums(bytes: &[u8], page_bytes: usize) -> Vec<u8> {
    let mut checksums = Vec::with_capacity(bytes.len().div_ceil(page_bytes) * 4);
    for page in bytes.chunks(page_bytes) {
        checksums.extend_from_slice(&crc32(page).to_le_bytes());
    }
    checksums
}

impl FileSection {
    pub(crate) fn of(
        name: &'static str,
        offset: usize,
        bytes: &[u8],
        page_bytes: usize,
    ) -> FileSection {
        FileSection {
            name,
            offset,
            length: bytes.len(),
            page_bytes,
            checksums: page_checksums(bytes, page_bytes),
        }
    }

    pub(crate) fn write(&self, out: &mut Vec<u8>) {
        write_map_header(out, SECTION_KEYS);
        write_string(out, "name");
        write_string(out, self.name);
        write_string(out, "offset");
        write_uint(out, self.offset as u64);
        write_string(out, "length");
        write_uint(out, self.length as u64);
        write_string(out, "pageBytes");
        write_uint(out, self.page_bytes as u64);
        write_string(out, "checksums");
        write_binary(out, &self.checksums);
    }
}

pub(crate) fn write_sections(out: &mut Vec<u8>, sections: &[FileSection]) {
    write_array_header(out, sections.len());
    for section in sections {
        section.write(out);
    }
}

pub(crate) fn binary_header_bytes(length: usize) -> usize {
    if length <= 0xff {
        2
    } else if length <= 0xffff {
        3
    } else {
        5
    }
}

pub(crate) fn string_entry_bytes(text: &str) -> usize {
    let mut out = Vec::with_capacity(text.len() + 5);
    write_string(&mut out, text);
    out.len()
}

/// Builds a MessagePack payload in one buffer and reports where each binary value starts.
pub(crate) struct PayloadBuilder {
    pub(crate) bytes: Vec<u8>,
}

impl PayloadBuilder {
    pub(crate) fn with_capacity(capacity: usize) -> PayloadBuilder {
        PayloadBuilder {
            bytes: Vec::with_capacity(capacity),
        }
    }

    pub(crate) fn offset(&self) -> usize {
        self.bytes.len()
    }

    pub(crate) fn key(&mut self, key: &str) {
        write_string(&mut self.bytes, key);
    }

    pub(crate) fn bytes_entry(&mut self, key: &str, bytes: &[u8]) -> usize {
        self.key(key);
        write_binary(&mut self.bytes, bytes);
        self.bytes.len() - bytes.len()
    }

    pub(crate) fn head_entry(&mut self, head: &[u8]) -> Head {
        let offset = self.bytes_entry("head", head);
        Head {
            offset: offset as u64,
            length: head.len() as u32,
            checksum: crc32(head),
        }
    }
}

/// Encodes a head that lists the section of bytes written after it, repeating until the head's length settles.
pub(crate) fn settled_head(
    before_head: usize,
    trailing_entry_bytes: usize,
    encode: impl Fn(usize) -> Vec<u8>,
) -> Result<Vec<u8>> {
    let mut head_length = 0;
    for _ in 0..STABLE_HEAD_ATTEMPTS {
        let trailing_offset =
            before_head + binary_header_bytes(head_length) + head_length + trailing_entry_bytes;
        let head = encode(trailing_offset);
        if head.len() == head_length {
            return Ok(head);
        }
        head_length = head.len();
    }
    Err(NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        "The head of a paged file did not settle on one length",
    ))
}
