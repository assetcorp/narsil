use std::io::{Read, Write};

use crate::error::{ErrorCode, NarsilError, Result, fail, load_failed};
use crate::util::hash::crc32;

pub(crate) const HEADER_BYTES: usize = 32;
pub(crate) const MAX_FILE_BYTES: u64 = 2_147_483_647;
const MAX_PAYLOAD_BYTES: u64 = 0xffff_ffff;
const MAGIC: [u8; 4] = *b"NRSL";
const FLAG_COMPRESSED: u16 = 1;
const FLAG_ALGORITHM_SHIFT: u16 = 1;
const FLAG_ALGORITHM_MASK: u16 = 0b11;
const FLAG_CHECKSUM: u16 = 1 << 3;
const FLAG_ENCRYPTED: u16 = 1 << 4;
const ALGORITHM_GZIP: u16 = 0b01;

/// The engine version that this crate writes into the header of every file.
pub(crate) const ENGINE_VERSION: [u8; 3] = [0, 1, 0];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Compression {
    None,
    Gzip,
    Lz4,
    Zstd,
}

impl Compression {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Compression::None => "none",
            Compression::Gzip => "gzip",
            Compression::Lz4 => "lz4",
            Compression::Zstd => "zstd",
        }
    }
}

/// The 32-byte header that starts every `.nrsl` file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Header {
    pub(crate) envelope_format_version: u8,
    pub(crate) payload_length: u32,
    pub(crate) compressed: bool,
    pub(crate) algorithm: Compression,
    pub(crate) checksum_present: bool,
    pub(crate) encrypted: bool,
    pub(crate) checksum: u32,
}

impl Header {
    pub(crate) fn compression(&self) -> Compression {
        if self.compressed {
            self.algorithm
        } else {
            Compression::None
        }
    }
}

/// The place of the envelope format version byte in a file's header.
pub(crate) const ENVELOPE_VERSION_BYTE: u64 = 4;

pub(crate) fn read_header(data: &[u8]) -> Result<Header> {
    if data.len() < HEADER_BYTES {
        return fail(
            ErrorCode::ENVELOPE_INVALID_MAGIC,
            format!(
                "Expected at least {HEADER_BYTES} bytes, received {}",
                data.len()
            ),
        );
    }
    if data[0..4] != MAGIC {
        return fail(
            ErrorCode::ENVELOPE_INVALID_MAGIC,
            "File does not begin with NRSL magic bytes",
        );
    }
    let flags = u16::from_be_bytes([data[12], data[13]]);
    let algorithm = match (flags >> FLAG_ALGORITHM_SHIFT) & FLAG_ALGORITHM_MASK {
        0 => Compression::None,
        1 => Compression::Gzip,
        2 => Compression::Lz4,
        _ => Compression::Zstd,
    };
    Ok(Header {
        envelope_format_version: data[4],
        payload_length: u32::from_be_bytes([data[8], data[9], data[10], data[11]]),
        compressed: flags & FLAG_COMPRESSED != 0,
        algorithm,
        checksum_present: flags & FLAG_CHECKSUM != 0,
        encrypted: flags & FLAG_ENCRYPTED != 0,
        checksum: u32::from_be_bytes([data[14], data[15], data[16], data[17]]),
    })
}

pub(crate) fn write_header(
    envelope_format_version: u8,
    payload_length: u64,
    compression: Compression,
    checksum: Option<u32>,
) -> Result<[u8; HEADER_BYTES]> {
    if payload_length > MAX_PAYLOAD_BYTES {
        return fail(
            ErrorCode::PERSISTENCE_SAVE_FAILED,
            format!(
                "A payload of {payload_length} bytes exceeds the {MAX_PAYLOAD_BYTES} bytes the envelope header can describe"
            ),
        );
    }
    let mut header = [0u8; HEADER_BYTES];
    header[0..4].copy_from_slice(&MAGIC);
    header[4] = envelope_format_version;
    header[5..8].copy_from_slice(&ENGINE_VERSION);
    header[8..12].copy_from_slice(&(payload_length as u32).to_be_bytes());
    let mut flags = 0u16;
    if compression == Compression::Gzip {
        flags |= FLAG_COMPRESSED | (ALGORITHM_GZIP << FLAG_ALGORITHM_SHIFT);
    }
    if let Some(checksum) = checksum {
        flags |= FLAG_CHECKSUM;
        header[14..18].copy_from_slice(&checksum.to_be_bytes());
    }
    header[12..14].copy_from_slice(&flags.to_be_bytes());
    Ok(header)
}

pub(crate) fn require_within_file_limit(byte_length: u64, what: &str) -> Result<()> {
    if byte_length <= MAX_FILE_BYTES {
        return Ok(());
    }
    fail(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!(
            "The {what} would take {byte_length} bytes, above the file size limit of {MAX_FILE_BYTES}"
        ),
    )
}

pub(crate) fn gzip(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(bytes)
        .and_then(|_| encoder.finish())
        .map_err(|error| {
            NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!("gzip failed: {error}"),
            )
        })
}

pub(crate) fn gunzip_within(compressed: &[u8], limit: u64, what: &str) -> Result<Vec<u8>> {
    let mut decoder = flate2::read::MultiGzDecoder::new(compressed).take(limit + 1);
    let mut out = Vec::new();
    if let Err(error) = decoder.read_to_end(&mut out) {
        return load_failed(format!(
            "The {what} holds a gzip payload that fails to inflate: {error}"
        ));
    }
    if out.len() as u64 > limit {
        return load_failed(format!(
            "The {what} inflates past the file size limit of {limit} bytes"
        ));
    }
    Ok(out)
}

/// Wraps a payload in a header with the checksum flag set, compressing it first where `compression` asks for gzip.
pub(crate) fn pack(
    payload: &[u8],
    envelope_format_version: u8,
    compression: Compression,
    what: &str,
) -> Result<Vec<u8>> {
    let compressed;
    let body = if compression == Compression::Gzip {
        compressed = gzip(payload)?;
        &compressed[..]
    } else {
        payload
    };
    require_within_file_limit((HEADER_BYTES + body.len()) as u64, what)?;
    let header = write_header(
        envelope_format_version,
        body.len() as u64,
        compression,
        Some(crc32(body)),
    )?;
    let mut out = Vec::with_capacity(HEADER_BYTES + body.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(body);
    Ok(out)
}

pub(crate) struct Expectation<'a> {
    pub(crate) version: u8,
    pub(crate) what: &'a str,
    pub(crate) allows_compression: bool,
}

pub(crate) enum Payload<'a> {
    Borrowed(&'a [u8]),
    Owned(Vec<u8>),
}

impl Payload<'_> {
    pub(crate) fn bytes(&self) -> &[u8] {
        match self {
            Payload::Borrowed(bytes) => bytes,
            Payload::Owned(bytes) => bytes,
        }
    }
}

/// Checks a file whose format requires a checksum, in the order of the reference reader, and returns its payload.
pub(crate) fn open_checksummed<'a>(
    data: &'a [u8],
    expected: &Expectation<'_>,
) -> Result<(Header, Payload<'a>)> {
    let what = expected.what;
    let header = read_header(data)?;
    if header.envelope_format_version != expected.version {
        return fail(
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            format!(
                "The {what} holds envelope format v{}, while this build reads it as v{}",
                header.envelope_format_version, expected.version
            ),
        );
    }
    if header.encrypted {
        return fail(
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            format!("The {what} is encrypted, which this build cannot read"),
        );
    }
    if header.compressed && !expected.allows_compression {
        return load_failed(format!(
            "The {what} is compressed, while its format stores it raw"
        ));
    }
    if header.compressed && header.algorithm != Compression::Gzip {
        return fail(
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            format!(
                "The {what} uses {} compression, which this build cannot read",
                header.algorithm.name()
            ),
        );
    }
    if !header.checksum_present {
        return load_failed(format!(
            "The {what} carries no checksum, while its format requires one"
        ));
    }
    let wanted = HEADER_BYTES as u64 + header.payload_length as u64;
    if data.len() as u64 != wanted {
        return load_failed(format!(
            "The {what} holds {} bytes where its header gives {wanted}",
            data.len()
        ));
    }
    let payload = &data[HEADER_BYTES..];
    if crc32(payload) != header.checksum {
        return fail(
            ErrorCode::PERSISTENCE_CRC_MISMATCH,
            format!("The checksum of the {what} does not match its payload"),
        );
    }
    if header.compressed {
        return Ok((
            header,
            Payload::Owned(gunzip_within(payload, MAX_FILE_BYTES, what)?),
        ));
    }
    Ok((header, Payload::Borrowed(payload)))
}
