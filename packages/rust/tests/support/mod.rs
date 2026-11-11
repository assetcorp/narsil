#![allow(dead_code)]

pub mod adapters;
pub mod filter_parity;
pub mod parity;
pub mod parity_cases;
pub mod portable;
pub mod shaping;
pub mod shaping_compare;
pub mod shaping_json;
pub mod suggestions;
pub mod vector_params;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

pub fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root exists")
}

pub fn conformance_root() -> PathBuf {
    repository_root().join("packages/conformance")
}

pub struct ScratchDirectory {
    path: PathBuf,
}

impl ScratchDirectory {
    pub fn new(label: &str) -> ScratchDirectory {
        let serial = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "narsil-rust-{label}-{}-{serial}",
            std::process::id()
        ));
        if path.exists() {
            std::fs::remove_dir_all(&path).expect("a stale scratch directory is removed");
        }
        std::fs::create_dir_all(&path).expect("the scratch directory is made");
        ScratchDirectory { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
