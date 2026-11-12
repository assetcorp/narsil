use crate::error::{ErrorCode, Result, fail, load_failed};
use crate::format::envelope::{
    Compression, HEADER_BYTES, Header, MAX_FILE_BYTES, gunzip_within, gzip, read_header,
    write_header,
};
use crate::util::hash::crc32;

/// Opens an envelope of version 1 at most, with an optional checksum, as the reference reads metadata files.
pub(crate) fn open_lenient_envelope(data: &[u8], max_version: u8) -> Result<(Header, Vec<u8>)> {
    let header = read_header(data)?;
    if header.envelope_format_version > max_version {
        return fail(
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            format!(
                "This data holds Narsil envelope format v{}, while this build reads up to v{max_version}",
                header.envelope_format_version
            ),
        );
    }
    if header.encrypted {
        return fail(
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            "Encrypted envelopes are not supported in this version of Narsil",
        );
    }
    if header.compressed
        && header.algorithm != Compression::Gzip
        && header.algorithm != Compression::None
    {
        return fail(
            ErrorCode::ENVELOPE_VERSION_MISMATCH,
            format!(
                "Compression algorithm \"{}\" is not supported in this version of Narsil",
                header.algorithm.name()
            ),
        );
    }
    let available = data.len() - HEADER_BYTES;
    if available < header.payload_length as usize {
        return load_failed(format!(
            "Envelope data is truncated: header declares {} bytes of payload but only {available} bytes are available",
            header.payload_length
        ));
    }
    let payload = &data[HEADER_BYTES..HEADER_BYTES + header.payload_length as usize];
    if header.checksum_present && crc32(payload) != header.checksum {
        return fail(
            ErrorCode::PERSISTENCE_CRC_MISMATCH,
            "CRC32 checksum mismatch: data may be corrupted",
        );
    }
    if header.compressed && header.algorithm == Compression::Gzip {
        return Ok((header, gunzip_within(payload, MAX_FILE_BYTES, "envelope")?));
    }
    Ok((header, payload.to_vec()))
}

pub(crate) fn pack_lenient_envelope(
    payload: &[u8],
    version: u8,
    compression: Compression,
    checksum: bool,
) -> Result<Vec<u8>> {
    let body = if compression == Compression::Gzip {
        gzip(payload)?
    } else {
        payload.to_vec()
    };
    let header = write_header(
        version,
        body.len() as u64,
        compression,
        checksum.then(|| crc32(&body)),
    )?;
    let mut out = Vec::with_capacity(HEADER_BYTES + body.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&body);
    Ok(out)
}
