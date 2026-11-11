use std::fmt::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{ErrorCode, NarsilError, Result};
use crate::util::unwind::guarded;

const UUID_VERSION_SEVEN: u8 = 0x70;
const UUID_VERSION_FOUR: u8 = 0x40;
const UUID_VARIANT: u8 = 0x80;
const UUID_BYTES: usize = 16;
const UUID_TEXT_LENGTH: usize = 36;

pub(crate) fn generated_id(generator: &super::engine_config::IdGenerator) -> Result<String> {
    guarded(ErrorCode::INTERNAL_ERROR, "The idGenerator", || generator())
}

fn random_bytes(what: &str) -> Result<[u8; UUID_BYTES]> {
    let mut bytes = [0u8; UUID_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| {
        NarsilError::new(
            ErrorCode::INTERNAL_ERROR,
            format!("The engine could not read random bytes for {what}: {error}"),
        )
    })?;
    Ok(bytes)
}

fn uuid_text(mut bytes: [u8; UUID_BYTES], version: u8) -> String {
    bytes[6] = (bytes[6] & 0x0f) | version;
    bytes[8] = (bytes[8] & 0x3f) | UUID_VARIANT;
    let mut text = String::with_capacity(UUID_TEXT_LENGTH);
    for (at, byte) in bytes.iter().enumerate() {
        if matches!(at, 4 | 6 | 8 | 10) {
            text.push('-');
        }
        let _ = write!(text, "{byte:02x}");
    }
    text
}

pub(crate) fn generate_id() -> Result<String> {
    let mut bytes = random_bytes("a document ID")?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    bytes[..6].copy_from_slice(&now.to_be_bytes()[2..]);
    Ok(uuid_text(bytes, UUID_VERSION_SEVEN))
}

pub(crate) fn random_uuid(what: &str) -> Result<String> {
    Ok(uuid_text(random_bytes(what)?, UUID_VERSION_FOUR))
}
