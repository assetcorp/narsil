const PADDING: u8 = b'=';
const LOW_BYTE_MASK: u16 = 0x00ff;
const SEXTET_BITS: u32 = 6;
const SEXTETS_PER_GROUP: u32 = 4;

fn sextet(byte: u8) -> Option<u32> {
    match byte {
        b'A'..=b'Z' => Some(u32::from(byte - b'A')),
        b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// Returns the bytes that Node's `Buffer.from(text, 'base64')` returns for `text`, which is how the reference
/// engine reads a cursor.
///
/// Node reads the low byte of each UTF-16 code unit, accepts the standard and the URL-safe alphabet, skips every
/// other byte, stops at the first padding character, and keeps the whole bytes of a final partial group.
pub(crate) fn decode_as_node(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 3);
    let mut held = 0u32;
    let mut count = 0u32;
    for unit in text.encode_utf16() {
        let byte = (unit & LOW_BYTE_MASK) as u8;
        if byte == PADDING {
            break;
        }
        let Some(value) = sextet(byte) else {
            continue;
        };
        held = (held << SEXTET_BITS) | value;
        count += 1;
        if count == SEXTETS_PER_GROUP {
            out.extend_from_slice(&[(held >> 16) as u8, (held >> 8) as u8, held as u8]);
            held = 0;
            count = 0;
        }
    }
    match count {
        2 => out.push((held >> 4) as u8),
        3 => out.extend_from_slice(&[(held >> 10) as u8, (held >> 2) as u8]),
        _ => {}
    }
    out
}
