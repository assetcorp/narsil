const FNV_OFFSET_BASIS: u32 = 2_166_136_261;
const FNV_PRIME: u32 = 16_777_619;
const BASE36_DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";

pub(crate) fn fnv1a(bytes: &[u8]) -> u32 {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in bytes {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

pub(crate) fn crc32(bytes: &[u8]) -> u32 {
    crc32fast::hash(bytes)
}

pub(crate) fn base36(mut number: u32) -> String {
    if number == 0 {
        return "0".to_string();
    }
    let mut digits = Vec::new();
    while number > 0 {
        digits.push(BASE36_DIGITS[(number % 36) as usize]);
        number /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
