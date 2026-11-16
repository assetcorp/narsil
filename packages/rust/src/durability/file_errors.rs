use std::io::{self, Write};
use std::path::Path;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::value::Value;

fn key_and_cause(key: &str, error: &io::Error) -> [(&'static str, Value); 2] {
    [
        ("key", Value::from(key)),
        ("cause", Value::from(error.to_string())),
    ]
}

pub(crate) fn fsync_failed(key: &str, error: &io::Error) -> NarsilError {
    fsync_failure(key, error).with_details(key_and_cause(key, error))
}

fn fsync_failure(target: &str, error: &io::Error) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_FSYNC_FAILED,
        format!(
            "fsync failed for \"{target}\"; the write is not acknowledged and the node must recover from the durable log: {error}"
        ),
    )
}

pub(crate) fn directory_fsync_failed(directory: &Path, error: &io::Error) -> NarsilError {
    fsync_failure(&directory.to_string_lossy(), error)
        .with_details([("cause", Value::from(error.to_string()))])
}

pub(crate) fn write_failed(key: &str, error: &io::Error) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!("Write to \"{key}\" failed; the write is not acknowledged: {error}"),
    )
    .with_details(key_and_cause(key, error))
}

pub(crate) fn write_fully(out: &mut impl Write, bytes: &[u8], key: &str) -> Result<()> {
    let mut written = 0;
    while written < bytes.len() {
        match out.write(&bytes[written..]) {
            Ok(0) => {
                return Err(NarsilError::new(
                    ErrorCode::PERSISTENCE_SAVE_FAILED,
                    format!(
                        "Write to \"{key}\" made no progress; the file would be truncated and the write is not acknowledged"
                    ),
                )
                .with_details([
                    ("key", Value::from(key)),
                    ("written", Value::from(written)),
                    ("total", Value::from(bytes.len())),
                ]));
            }
            Ok(count) => written += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => {
                return Err(NarsilError::new(
                    ErrorCode::PERSISTENCE_SAVE_FAILED,
                    format!("Write to \"{key}\" failed; the write is not acknowledged: {error}"),
                )
                .with_details([
                    ("key", Value::from(key)),
                    ("written", Value::from(written)),
                    ("total", Value::from(bytes.len())),
                    ("cause", Value::from(error.to_string())),
                ]));
            }
        }
    }
    Ok(())
}

pub(crate) fn read_failed(key: &str, error: &io::Error) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("Failed to read \"{key}\": {error}"),
    )
    .with_details(key_and_cause(key, error))
}

pub(crate) fn range_outside(key: &str, offset: u64, length: u64) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_LOAD_FAILED,
        format!("\"{key}\" ends before the bytes a read asked for"),
    )
    .with_details([
        ("key", Value::from(key)),
        ("offset", Value::from(offset)),
        ("length", Value::from(length)),
    ])
}

pub(crate) fn delete_failed(key: &str, error: &io::Error) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_DELETE_FAILED,
        format!("Failed to delete \"{key}\": {error}"),
    )
    .with_details(key_and_cause(key, error))
}

fn invalid_key(key: &str, reason: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!("Invalid key \"{}\": {reason}", key.escape_debug()),
    )
}

pub(crate) fn require_valid_key(key: &str) -> Result<()> {
    if key.is_empty() {
        return Err(invalid_key(key, "empty"));
    }
    if key.contains('\0') {
        return Err(
            invalid_key(key, "null byte detected").with_details([("key", Value::from(key))])
        );
    }
    let traverses = key.split('/').any(|part| {
        part.is_empty() || part == "." || part == ".." || part.contains('\\') || part.contains(':')
    });
    if traverses {
        return Err(
            invalid_key(key, "path traversal detected").with_details([("key", Value::from(key))])
        );
    }
    Ok(())
}
