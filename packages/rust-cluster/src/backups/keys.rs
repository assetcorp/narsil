use narsil::Value;

use super::constants::{MAX_BACKUP_KEY_PREFIX_LENGTH, MAX_BACKUP_NAME_LENGTH};
use super::types::ClusterBackupConfig;
use crate::error::{ClusterError, ClusterResult, codes};

const CLAIM_KEY: &str = "cluster";
const MANIFESTS_DIRECTORY: &str = "backups/";
const FILES_DIRECTORY: &str = "files/";
const SHA256_HEX_DIGITS: usize = 64;
const SHA256_DETAIL_CHARACTERS: usize = 80;

fn is_name_tail_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
}

fn clipped(text: &str, characters: usize) -> String {
    text.chars().take(characters).collect()
}

fn is_backup_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.chars().count() <= MAX_BACKUP_NAME_LENGTH
        && bytes
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && bytes.all(is_name_tail_byte)
}

/// Returns `backup_name` once it holds from 1 to 128 letters, digits, `.`, `_`, and `-`, and starts with a letter
/// or a digit.
///
/// # Errors
///
/// Fails with `CONFIG_INVALID` for any other name.
pub fn validate_backup_name(backup_name: &str) -> ClusterResult<String> {
    if is_backup_name(backup_name) {
        return Ok(backup_name.to_string());
    }
    Err(ClusterError::new(
        codes::CONFIG_INVALID,
        format!(
            "A backup name holds from 1 to {MAX_BACKUP_NAME_LENGTH} letters, digits, '.', '_', and '-', and starts with a letter or a digit"
        ),
    )
    .with_detail(
        "backupName",
        Value::String(clipped(backup_name, MAX_BACKUP_NAME_LENGTH)),
    ))
}

pub(crate) fn validate_backup_value(value: Option<&Value>) -> ClusterResult<String> {
    match value {
        Some(Value::String(name)) => validate_backup_name(name),
        _ => Err(ClusterError::new(
            codes::CONFIG_INVALID,
            format!(
                "A backup name holds from 1 to {MAX_BACKUP_NAME_LENGTH} letters, digits, '.', '_', and '-', and starts with a letter or a digit"
            ),
        )),
    }
}

fn is_prefix_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment.bytes().all(is_name_tail_byte)
}

pub(crate) fn validate_backup_key_prefix(key_prefix: &str) -> ClusterResult<String> {
    if key_prefix.chars().count() <= MAX_BACKUP_KEY_PREFIX_LENGTH
        && key_prefix.split('/').all(is_prefix_segment)
    {
        return Ok(key_prefix.to_string());
    }
    Err(ClusterError::new(
        codes::CONFIG_INVALID,
        format!(
            "A backup key prefix holds up to {MAX_BACKUP_KEY_PREFIX_LENGTH} characters in segments joined by '/', where each segment holds letters, digits, '.', '_', and '-', and no segment is '.' or '..'"
        ),
    )
    .with_detail(
        "keyPrefix",
        Value::String(clipped(key_prefix, MAX_BACKUP_KEY_PREFIX_LENGTH)),
    ))
}

pub(crate) fn store_without_save_if_absent() -> ClusterError {
    ClusterError::new(
        codes::CONFIG_INVALID,
        "A backup store must offer saveIfAbsent, because a save followed by a read can't stop two clusters from both claiming an empty key prefix",
    )
}

pub(crate) fn validate_backup_config(backups: &ClusterBackupConfig) -> ClusterResult<()> {
    if !backups.store.offers_save_if_absent() {
        return Err(store_without_save_if_absent());
    }
    validate_backup_key_prefix(&backups.key_prefix).map(|_| ())
}

pub(crate) fn is_sha256_hex(value: &str) -> bool {
    value.len() == SHA256_HEX_DIGITS
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) struct BackupKeys {
    pub(crate) claim: String,
    pub(crate) manifests: String,
    pub(crate) files: String,
}

impl BackupKeys {
    pub(crate) fn new(key_prefix: &str) -> ClusterResult<BackupKeys> {
        let prefix = format!("{}/", validate_backup_key_prefix(key_prefix)?);
        Ok(BackupKeys {
            claim: format!("{prefix}{CLAIM_KEY}"),
            manifests: format!("{prefix}{MANIFESTS_DIRECTORY}"),
            files: format!("{prefix}{FILES_DIRECTORY}"),
        })
    }

    pub(crate) fn manifest(&self, backup_name: &str) -> ClusterResult<String> {
        Ok(format!(
            "{}{}",
            self.manifests,
            validate_backup_name(backup_name)?
        ))
    }

    pub(crate) fn file(&self, sha256: &str) -> ClusterResult<String> {
        if !is_sha256_hex(sha256) {
            return Err(ClusterError::new(
                codes::BACKUP_DAMAGED,
                "A backup lists a file under a digest that is not SHA-256",
            )
            .with_detail(
                "sha256",
                Value::String(clipped(sha256, SHA256_DETAIL_CHARACTERS)),
            ));
        }
        Ok(format!("{}{sha256}", self.files))
    }
}
