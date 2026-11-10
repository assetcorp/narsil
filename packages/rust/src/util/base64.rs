const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD: u8 = b'=';

pub(crate) fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0] as u32;
        let second = chunk.get(1).copied().unwrap_or(0) as u32;
        let third = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (first << 16) | (second << 8) | third;
        out.push(ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 63] as char
        } else {
            PAD as char
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 63] as char
        } else {
            PAD as char
        });
    }
    out
}

fn sextet(byte: u8) -> Option<u32> {
    ALPHABET
        .iter()
        .position(|candidate| *candidate == byte)
        .map(|place| place as u32)
}

/// Decodes padded base64 and returns `None` unless re-encoding the bytes gives back exactly `text`.
pub(crate) fn decode_exact(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (index, quad) in bytes.chunks(4).enumerate() {
        let last = index + 1 == bytes.len() / 4;
        let padding = quad.iter().rev().take_while(|byte| **byte == PAD).count();
        if padding > 2 || (padding > 0 && !last) {
            return None;
        }
        let mut triple = 0u32;
        for (at, byte) in quad.iter().enumerate() {
            let value = if at >= 4 - padding { 0 } else { sextet(*byte)? };
            triple = (triple << 6) | value;
        }
        out.push((triple >> 16) as u8);
        if padding < 2 {
            out.push((triple >> 8) as u8);
        }
        if padding < 1 {
            out.push(triple as u8);
        }
    }
    (encode(&out) == text).then_some(out)
}
