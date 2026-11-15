use std::path::{Path, PathBuf};

use http_body_util::BodyExt;
use hyper::body::Incoming;
use tokio::io::AsyncWriteExt;

use super::body::{drain_in_background, too_large};
use crate::errors::{ServerError, server_codes};
use crate::ids::random_hex;

const SPOOL_DIRECTORY_PREFIX: &str = "narsil-spool-";
const SPOOL_FILE_NAME: &str = "body";

pub(crate) struct SpooledBody {
    directory: PathBuf,
    path: PathBuf,
    pub(crate) bytes: u64,
}

impl SpooledBody {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for SpooledBody {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn store_failure() -> ServerError {
    ServerError::new(
        500,
        server_codes::INTERNAL_ERROR,
        "The server could not store the request body",
    )
}

#[cfg(unix)]
async fn create_private_directory(directory: &Path) -> std::io::Result<()> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.mode(0o700);
    builder.create(directory).await
}

#[cfg(not(unix))]
async fn create_private_directory(directory: &Path) -> std::io::Result<()> {
    tokio::fs::create_dir(directory).await
}

pub(crate) enum SpoolOutcome {
    Stored(SpooledBody),
    Refused(ServerError),
    Ended,
}

pub(crate) async fn spool_body(mut body: Incoming, max_bytes: u64) -> SpoolOutcome {
    let Some(suffix) = random_hex(16) else {
        drain_in_background(body);
        return SpoolOutcome::Refused(store_failure());
    };
    let directory = std::env::temp_dir().join(format!("{SPOOL_DIRECTORY_PREFIX}{suffix}"));
    if create_private_directory(&directory).await.is_err() {
        drain_in_background(body);
        return SpoolOutcome::Refused(store_failure());
    }
    let path = directory.join(SPOOL_FILE_NAME);
    let mut spooled = SpooledBody {
        directory,
        path,
        bytes: 0,
    };
    let Ok(mut file) = tokio::fs::File::create(&spooled.path).await else {
        drain_in_background(body);
        return SpoolOutcome::Refused(store_failure());
    };
    loop {
        let Some(frame) = body.frame().await else {
            break;
        };
        let Ok(frame) = frame else {
            return SpoolOutcome::Ended;
        };
        let Ok(chunk) = frame.into_data() else {
            continue;
        };
        spooled.bytes = spooled.bytes.saturating_add(chunk.len() as u64);
        if max_bytes > 0 && spooled.bytes > max_bytes {
            drain_in_background(body);
            return SpoolOutcome::Refused(too_large());
        }
        if file.write_all(&chunk).await.is_err() {
            drain_in_background(body);
            return SpoolOutcome::Refused(store_failure());
        }
    }
    if file.flush().await.is_err() || file.sync_data().await.is_err() {
        return SpoolOutcome::Refused(store_failure());
    }
    SpoolOutcome::Stored(spooled)
}
