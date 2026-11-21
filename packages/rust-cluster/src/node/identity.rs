use std::fmt::Write as _;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use narsil::Value;

use crate::error::{ClusterError, ClusterResult, codes};

const NODE_ID_FILE_NAME: &str = ".narsil-node-id";
const UUID_BYTES: usize = 16;
const UUID_TEXT_LENGTH: usize = 36;
const UUID_VERSION_SEVEN: u8 = 0x70;
const UUID_VARIANT: u8 = 0x80;

/// Returns a new node id, a UUID version 7 in lowercase text, which is the id that TypeScript generates.
///
/// # Errors
///
/// Fails with `INTERNAL_ERROR` where the system offers no random bytes.
pub fn generate_node_id() -> ClusterResult<String> {
    let mut bytes = [0u8; UUID_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| {
        ClusterError::new(
            codes::INTERNAL_ERROR,
            format!("The node could not read random bytes for its id: {error}"),
        )
    })?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    bytes[..6].copy_from_slice(&now.to_be_bytes()[2..]);
    bytes[6] = (bytes[6] & 0x0f) | UUID_VERSION_SEVEN;
    bytes[8] = (bytes[8] & 0x3f) | UUID_VARIANT;
    let mut text = String::with_capacity(UUID_TEXT_LENGTH);
    for (at, byte) in bytes.iter().enumerate() {
        if matches!(at, 4 | 6 | 8 | 10) {
            text.push('-');
        }
        let _ = write!(text, "{byte:02x}");
    }
    Ok(text)
}

fn is_stored_node_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != UUID_TEXT_LENGTH {
        return false;
    }
    let lower_hex = |byte: u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte);
    bytes.iter().enumerate().all(|(at, &byte)| match at {
        8 | 13 | 18 | 23 => byte == b'-',
        14 => byte == b'7',
        19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
        _ => lower_hex(byte),
    })
}

fn read_stored_node_id(file: &Path) -> ClusterResult<Option<String>> {
    let text = match std::fs::read(file) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(cannot_store(file.parent().unwrap_or(file), &error)),
    };
    let node_id = text.trim();
    if !is_stored_node_id(node_id) {
        return Err(ClusterError::new(
            codes::CONFIG_INVALID,
            format!(
                "The node id file \"{}\" holds no node id that this node wrote. Restore the file, or delete it so that the node starts under a new id, which leaves the copies it held for the cluster to rebuild",
                file.display()
            ),
        )
        .with_detail("file", Value::String(file.display().to_string())));
    }
    Ok(Some(node_id.to_string()))
}

fn cannot_store(directory: &Path, error: &std::io::Error) -> ClusterError {
    ClusterError::new(
        codes::PERSISTENCE_SAVE_FAILED,
        format!(
            "The node cannot read or store its id in \"{}\"",
            directory.display()
        ),
    )
    .with_detail("directory", Value::String(directory.display().to_string()))
    .with_detail("cause", Value::String(error.to_string()))
}

fn store_new_node_id(directory: &Path, file: &Path) -> ClusterResult<String> {
    let node_id = generate_node_id()?;
    let draft = PathBuf::from(format!("{}.{}.draft", file.display(), std::process::id()));
    let write_draft = || -> std::io::Result<()> {
        let mut handle = std::fs::File::create(&draft)?;
        handle.write_all(format!("{node_id}\n").as_bytes())?;
        handle.sync_all()
    };
    write_draft().map_err(|error| cannot_store(directory, &error))?;
    narsil::rename_replacing(&draft, file).map_err(|error| cannot_store(directory, &error))?;
    if let Ok(handle) = std::fs::File::open(directory) {
        let _ = handle.sync_all();
    }
    Ok(node_id)
}

/// Returns the id that this node joins under: `explicit` where the caller gives one, the id stored in
/// `.narsil-node-id` under `directory` where that file exists, and otherwise a new id, which the node stores in
/// that file so that a restart keeps it.
///
/// # Errors
///
/// Fails with `CONFIG_INVALID` where `explicit` is empty or where the file holds anything other than an id that a
/// node wrote, and with `PERSISTENCE_SAVE_FAILED` where the node cannot read or write the file.
pub fn resolve_node_id(explicit: Option<&str>, directory: Option<&Path>) -> ClusterResult<String> {
    if let Some(node_id) = explicit {
        if node_id.is_empty() {
            return Err(ClusterError::new(
                codes::CONFIG_INVALID,
                "ClusterNodeConfig.nodeId must be a non-empty string without an unpaired surrogate, the half of a character such as an emoji whose other half is missing, because the cluster hashes, sorts, and stores node ids as UTF-8",
            ));
        }
        return Ok(node_id.to_string());
    }
    let Some(directory) = directory else {
        return generate_node_id();
    };
    let root = std::path::absolute(directory).map_err(|error| cannot_store(directory, &error))?;
    let file = root.join(NODE_ID_FILE_NAME);
    match read_stored_node_id(&file)? {
        Some(node_id) => Ok(node_id),
        None => store_new_node_id(&root, &file),
    }
}
