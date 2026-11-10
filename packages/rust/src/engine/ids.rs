use std::fmt::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{ErrorCode, NarsilError, Result};

const UUID_VERSION_SEVEN: u8 = 0x70;
const UUID_VARIANT: u8 = 0x80;

/// Returns the ID that the program's ID generator gives, raising `INTERNAL_ERROR` where the generator panics, so
/// that a panic never unwinds through a held write lock.
pub(crate) fn generated_id(generator: &super::engine_config::IdGenerator) -> Result<String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| generator())).map_err(|_| {
        NarsilError::new(
            ErrorCode::INTERNAL_ERROR,
            "The idGenerator panicked while the engine asked it for a document ID",
        )
    })
}

/// Returns a new document ID in the UUID version 7 layout: the time in milliseconds, then random bits.
pub(crate) fn generate_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| {
        NarsilError::new(
            ErrorCode::INTERNAL_ERROR,
            format!("The engine could not read random bytes for a document ID: {error}"),
        )
    })?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    bytes[..6].copy_from_slice(&now.to_be_bytes()[2..]);
    bytes[6] = (bytes[6] & 0x0f) | UUID_VERSION_SEVEN;
    bytes[8] = (bytes[8] & 0x3f) | UUID_VARIANT;
    let mut text = String::with_capacity(36);
    for (at, byte) in bytes.iter().enumerate() {
        if matches!(at, 4 | 6 | 8 | 10) {
            text.push('-');
        }
        let _ = write!(text, "{byte:02x}");
    }
    Ok(text)
}
