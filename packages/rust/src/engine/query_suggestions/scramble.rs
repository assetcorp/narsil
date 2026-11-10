use sha2::{Digest, Sha256};

use super::constants::{
    KEY_FINGERPRINT_BYTES, KEY_FINGERPRINT_LABEL, MIN_KEY_BYTES, SCRAMBLED_ID_BYTES,
};
use crate::error::{ErrorCode, NarsilError, Result};

const SHA256_BLOCK_BYTES: usize = 64;
const INNER_PAD: u8 = 0x36;
const OUTER_PAD: u8 = 0x5c;

/// A person's ID after HMAC-SHA-256 under the engine's key, cut to its first 16 bytes.
pub(crate) type ScrambledId = [u8; SCRAMBLED_ID_BYTES];

/// Scrambles each person's ID with the engine's secret key, which never leaves this value.
pub(crate) struct Scrambler {
    inner: Sha256,
    outer: Sha256,
    fingerprint: [u8; KEY_FINGERPRINT_BYTES],
}

fn padded(key: &[u8], pad: u8) -> Sha256 {
    let mut block = [pad; SHA256_BLOCK_BYTES];
    for (slot, byte) in block.iter_mut().zip(key) {
        *slot ^= byte;
    }
    let mut hasher = Sha256::new();
    hasher.update(block);
    hasher
}

impl Scrambler {
    /// Returns the scrambler of `key`, refusing a key of fewer than 32 bytes with `CONFIG_INVALID`.
    pub(crate) fn new(key: &[u8]) -> Result<Scrambler> {
        if key.len() < MIN_KEY_BYTES {
            return Err(NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                format!(
                    "The query suggestions key must hold at least {MIN_KEY_BYTES} bytes, and it holds {}",
                    key.len()
                ),
            ));
        }
        let hashed;
        let block_key = if key.len() > SHA256_BLOCK_BYTES {
            hashed = Sha256::digest(key);
            hashed.as_slice()
        } else {
            key
        };
        let mut scrambler = Scrambler {
            inner: padded(block_key, INNER_PAD),
            outer: padded(block_key, OUTER_PAD),
            fingerprint: [0; KEY_FINGERPRINT_BYTES],
        };
        let mac = scrambler.mac(KEY_FINGERPRINT_LABEL.as_bytes());
        scrambler
            .fingerprint
            .copy_from_slice(&mac[..KEY_FINGERPRINT_BYTES]);
        Ok(scrambler)
    }

    fn mac(&self, message: &[u8]) -> [u8; 32] {
        let mut inner = self.inner.clone();
        inner.update(message);
        let mut outer = self.outer.clone();
        outer.update(inner.finalize());
        outer.finalize().into()
    }

    /// Returns the fingerprint of the key, which every history file carries.
    pub(crate) fn fingerprint(&self) -> &[u8; KEY_FINGERPRINT_BYTES] {
        &self.fingerprint
    }

    /// Returns the scrambled ID of `person`.
    pub(crate) fn scramble(&self, person: &str) -> ScrambledId {
        let mac = self.mac(person.as_bytes());
        let mut id = [0u8; SCRAMBLED_ID_BYTES];
        id.copy_from_slice(&mac[..SCRAMBLED_ID_BYTES]);
        id
    }
}
