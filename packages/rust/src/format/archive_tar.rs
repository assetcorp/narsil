use crate::error::{ErrorCode, NarsilError, Result};
use crate::util::text::is_javascript_whitespace;
use crate::value::MAX_SAFE_INTEGER;

pub(crate) const TAR_BLOCK_BYTES: usize = 512;
const NAME_OFFSET: usize = 0;
const NAME_BYTES: usize = 100;
const MODE_OFFSET: usize = 100;
const OWNER_OFFSET: usize = 108;
const GROUP_OFFSET: usize = 116;
const ID_FIELD_BYTES: usize = 8;
const SIZE_OFFSET: usize = 124;
const SIZE_FIELD_BYTES: usize = 12;
const SIZE_FIELD_DIGITS: usize = 11;
const MTIME_OFFSET: usize = 136;
const MTIME_FIELD_BYTES: usize = 12;
const CHECKSUM_FIELD_OFFSET: usize = 148;
const CHECKSUM_FIELD_BYTES: usize = 8;
const CHECKSUM_DIGITS: usize = 6;
const TYPEFLAG_OFFSET: usize = 156;
const MAGIC_OFFSET: usize = 257;
const MAGIC_BYTES: usize = 6;
const VERSION_OFFSET: usize = 263;
const VERSION_BYTES: usize = 2;
const PREFIX_OFFSET: usize = 345;
const PREFIX_BYTES: usize = 155;
const MODE_OCTAL: &str = "0000644";
const ZERO_OCTAL_7: &str = "0000000";
const ZERO_OCTAL_11: &str = "00000000000";
const REGULAR_FILE: u8 = 0x30;
const OLD_REGULAR_FILE: u8 = 0x00;
const PAX_EXTENDED_HEADER: u8 = 0x78;
const PAX_HEADER_NAME: &str = "PaxHeader";
const SPACE: u8 = 0x20;
const EQUALS: u8 = 0x3d;
const NEWLINE: u8 = 0x0a;

pub(crate) fn invalid_archive(message: impl AsRef<str>) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("Invalid snapshot archive: {}", message.as_ref()),
    )
}

fn write_text(block: &mut [u8], offset: usize, length: usize, value: &str) {
    let bytes = value.as_bytes();
    let count = bytes.len().min(length);
    block[offset..offset + count].copy_from_slice(&bytes[..count]);
}

fn write_octal(block: &mut [u8], offset: usize, digits: usize, value: u64) {
    write_text(block, offset, digits, &format!("{value:0digits$o}"));
}

fn header_checksum(block: &[u8]) -> u64 {
    let checksum_end = CHECKSUM_FIELD_OFFSET + CHECKSUM_FIELD_BYTES;
    block
        .iter()
        .enumerate()
        .map(|(at, &byte)| {
            if (CHECKSUM_FIELD_OFFSET..checksum_end).contains(&at) {
                u64::from(SPACE)
            } else {
                u64::from(byte)
            }
        })
        .sum()
}

fn ustar_block(name: &str, prefix: &str, size: u64, typeflag: u8) -> [u8; TAR_BLOCK_BYTES] {
    let mut block = [0u8; TAR_BLOCK_BYTES];
    write_text(&mut block, NAME_OFFSET, NAME_BYTES, name);
    write_text(&mut block, MODE_OFFSET, ID_FIELD_BYTES, MODE_OCTAL);
    write_text(&mut block, OWNER_OFFSET, ID_FIELD_BYTES, ZERO_OCTAL_7);
    write_text(&mut block, GROUP_OFFSET, ID_FIELD_BYTES, ZERO_OCTAL_7);
    write_octal(&mut block, SIZE_OFFSET, SIZE_FIELD_DIGITS, size);
    write_text(&mut block, MTIME_OFFSET, MTIME_FIELD_BYTES, ZERO_OCTAL_11);
    block[TYPEFLAG_OFFSET] = typeflag;
    write_text(&mut block, MAGIC_OFFSET, MAGIC_BYTES, "ustar");
    write_text(&mut block, VERSION_OFFSET, VERSION_BYTES, "00");
    write_text(&mut block, PREFIX_OFFSET, PREFIX_BYTES, prefix);
    let checksum = header_checksum(&block);
    write_octal(&mut block, CHECKSUM_FIELD_OFFSET, CHECKSUM_DIGITS, checksum);
    block[CHECKSUM_FIELD_OFFSET + CHECKSUM_DIGITS] = 0;
    block[CHECKSUM_FIELD_OFFSET + CHECKSUM_DIGITS + 1] = SPACE;
    block
}

fn split_for_ustar(name: &str) -> Option<(&str, &str)> {
    if name.len() <= NAME_BYTES {
        return Some((name, ""));
    }
    name.match_indices('/').find_map(|(slash, _)| {
        let (prefix, rest) = (&name[..slash], &name[slash + 1..]);
        (prefix.len() <= PREFIX_BYTES && rest.len() <= NAME_BYTES).then_some((rest, prefix))
    })
}

fn pax_record(key: &str, value: &str) -> String {
    let body = format!(" {key}={value}\n");
    let body_bytes = body.len();
    let mut digits = 1;
    while (body_bytes + digits).to_string().len() != digits {
        digits += 1;
    }
    format!("{}{body}", body_bytes + digits)
}

fn last_name_units(name: &str) -> &str {
    let mut units = 0;
    let mut start = name.len();
    for (at, character) in name.char_indices().rev() {
        units += character.len_utf16();
        if units > NAME_BYTES {
            break;
        }
        start = at;
    }
    let tail = &name[start..];
    match tail.find('/') {
        Some(slash) => &tail[slash + 1..],
        None => tail,
    }
}

pub(crate) fn tar_padding(size: u64) -> Vec<u8> {
    let remainder = (size % TAR_BLOCK_BYTES as u64) as usize;
    vec![
        0;
        if remainder == 0 {
            0
        } else {
            TAR_BLOCK_BYTES - remainder
        }
    ]
}

/// Returns the header blocks of one regular file, adding a pax `path` record when ustar cannot hold the name.
pub(crate) fn tar_entry_headers(name: &str, size: u64) -> Vec<u8> {
    if let Some((short, prefix)) = split_for_ustar(name) {
        return ustar_block(short, prefix, size, REGULAR_FILE).to_vec();
    }
    let record = pax_record("path", name);
    let mut out = Vec::with_capacity(TAR_BLOCK_BYTES * 3 + record.len());
    out.extend_from_slice(&ustar_block(
        PAX_HEADER_NAME,
        "",
        record.len() as u64,
        PAX_EXTENDED_HEADER,
    ));
    out.extend_from_slice(record.as_bytes());
    out.extend_from_slice(&tar_padding(record.len() as u64));
    out.extend_from_slice(&ustar_block(last_name_units(name), "", size, REGULAR_FILE));
    out
}

pub(crate) fn tar_end() -> Vec<u8> {
    vec![0; TAR_BLOCK_BYTES * 2]
}

fn read_text(block: &[u8], offset: usize, length: usize) -> Result<&str> {
    let field = &block[offset..offset + length];
    let end = field.iter().position(|&byte| byte == 0).unwrap_or(length);
    std::str::from_utf8(&field[..end])
        .map_err(|_| invalid_archive("an entry header holds a name that is not UTF-8"))
}

fn read_octal(block: &[u8], offset: usize, length: usize, what: &str) -> Result<u64> {
    let text = read_text(block, offset, length)?.trim_matches(is_javascript_whitespace);
    let invalid = || invalid_archive(format!("an entry header holds an invalid {what}"));
    if text.is_empty() || !text.bytes().all(|byte| (b'0'..=b'7').contains(&byte)) {
        return Err(invalid());
    }
    u64::from_str_radix(text, 8)
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(invalid)
}

/// The name, size, and kind of one tar header block.
pub(crate) struct TarHeader {
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) is_pax_header: bool,
}

pub(crate) fn is_zero_block(block: &[u8]) -> bool {
    block.iter().all(|&byte| byte == 0)
}

pub(crate) fn parse_tar_header(block: &[u8]) -> Result<TarHeader> {
    if read_octal(
        block,
        CHECKSUM_FIELD_OFFSET,
        CHECKSUM_FIELD_BYTES,
        "checksum",
    )? != header_checksum(block)
    {
        return Err(invalid_archive("an entry header fails its checksum"));
    }
    let typeflag = block[TYPEFLAG_OFFSET];
    if typeflag != REGULAR_FILE && typeflag != OLD_REGULAR_FILE && typeflag != PAX_EXTENDED_HEADER {
        return Err(invalid_archive(format!(
            "an entry has type {}, while an archive holds regular files alone",
            char::from(typeflag)
        )));
    }
    let name = read_text(block, NAME_OFFSET, NAME_BYTES)?;
    let prefix = read_text(block, PREFIX_OFFSET, PREFIX_BYTES)?;
    Ok(TarHeader {
        name: if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        },
        size: read_octal(block, SIZE_OFFSET, SIZE_FIELD_BYTES, "size")?,
        is_pax_header: typeflag == PAX_EXTENDED_HEADER,
    })
}

/// Parses a decimal number the way `Number.parseInt(text, 10)` does, returning `None` where it gives NaN.
pub(crate) fn parse_leading_integer(text: &str) -> Option<i128> {
    let trimmed = text.trim_start_matches(is_javascript_whitespace);
    let (negative, digits) = match trimmed.as_bytes().first() {
        Some(b'-') => (true, &trimmed[1..]),
        Some(b'+') => (false, &trimmed[1..]),
        _ => (false, trimmed),
    };
    let run = digits.bytes().take_while(u8::is_ascii_digit).count();
    if run == 0 {
        return None;
    }
    let value = digits[..run].parse::<i128>().unwrap_or(i128::MAX);
    Some(if negative { -value } else { value })
}

pub(crate) fn is_safe_integer(value: Option<i128>) -> Option<u64> {
    value
        .filter(|number| (0..=i128::from(MAX_SAFE_INTEGER)).contains(number))
        .map(|number| number as u64)
}

fn record_text(bytes: &[u8]) -> Result<&str> {
    std::str::from_utf8(bytes).map_err(|_| invalid_archive("a pax extended header is not UTF-8"))
}

/// Reads the records of a pax extended header, keeping the last value of each key.
pub(crate) fn parse_pax_records(body: &[u8]) -> Result<Vec<(String, String)>> {
    let mut records: Vec<(String, String)> = Vec::new();
    let malformed = || invalid_archive("a pax extended header holds a malformed record");
    let mut at = 0;
    while at < body.len() {
        let space = body[at..]
            .iter()
            .position(|&byte| byte == SPACE)
            .map(|found| at + found)
            .ok_or_else(malformed)?;
        let length = parse_leading_integer(record_text(&body[at..space])?);
        let length = match length {
            Some(length)
                if length > (space - at) as i128 && at as i128 + length <= body.len() as i128 =>
            {
                length as usize
            }
            _ => return Err(malformed()),
        };
        let record = &body[space + 1..at + length];
        let equals = record.iter().position(|&byte| byte == EQUALS);
        let (Some(equals), Some(&NEWLINE)) = (equals, record.last()) else {
            return Err(invalid_archive(
                "a pax extended header holds a record without a value",
            ));
        };
        let key = record_text(&record[..equals])?.to_string();
        let value = record_text(&record[equals + 1..record.len() - 1])?.to_string();
        records.retain(|(held, _)| *held != key);
        records.push((key, value));
        at += length;
    }
    Ok(records)
}
