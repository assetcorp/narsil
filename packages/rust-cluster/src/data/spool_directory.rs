use std::io;
use std::path::{Path, PathBuf};

use narsil::Value;

use crate::error::{ClusterError, ClusterResult, codes};
use crate::node::generate_node_id;

const DURABLE_SPOOL_DIRECTORY: &str = ".snapshot-transfer";
const TEMPORARY_SPOOL_DIRECTORY_PREFIX: &str = "narsil-snapshot-transfer-";
#[cfg(unix)]
const OWNER_ONLY_DIRECTORY_MODE: u32 = 0o700;

/// The directory that holds the snapshot archives a data node sends and receives while each transfer lasts. Dropping
/// it deletes the directory with every archive left in it.
pub(crate) struct SpoolDirectory {
    path: PathBuf,
}

fn spool_failure(path: &Path, error: &io::Error) -> ClusterError {
    ClusterError::new(
        codes::PERSISTENCE_SAVE_FAILED,
        format!("The snapshot spool directory could not be prepared: {error}"),
    )
    .with_detail("path", Value::String(path.display().to_string()))
}

fn create_owner_only(path: &Path, recursive: bool) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(OWNER_ONLY_DIRECTORY_MODE);
    }
    builder.create(path)
}

impl SpoolDirectory {
    /// Opens `.snapshot-transfer` under the engine's durability directory, emptied of any archive that a stopped
    /// process left behind, or a new directory under the system's temporary directory where the engine keeps no
    /// directory. Only this process's user can open either one.
    pub(crate) fn open(durability_directory: Option<&Path>) -> ClusterResult<SpoolDirectory> {
        let Some(durability_directory) = durability_directory else {
            let path = std::env::temp_dir().join(format!(
                "{TEMPORARY_SPOOL_DIRECTORY_PREFIX}{}",
                generate_node_id()?
            ));
            create_owner_only(&path, false).map_err(|error| spool_failure(&path, &error))?;
            return Ok(SpoolDirectory { path });
        };
        let path = durability_directory.join(DURABLE_SPOOL_DIRECTORY);
        match std::fs::remove_dir_all(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(spool_failure(&path, &error)),
        }
        create_owner_only(&path, true).map_err(|error| spool_failure(&path, &error))?;
        Ok(SpoolDirectory { path })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for SpoolDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
