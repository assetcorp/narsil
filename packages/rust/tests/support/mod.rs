#![allow(dead_code)]

pub mod adapters;
pub mod changes;
pub mod filter_parity;
pub mod folding;
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

use narsil::DocumentProjection;

pub const WHOLE_DOCUMENT: DocumentProjection = DocumentProjection::Fields {
    include: None,
    exclude: None,
    vectors: Some(true),
};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

pub fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root exists")
}

pub fn rewrite_saved_file(file: &Path, arguments: &[&str]) {
    assert!(file.is_file(), "{} exists", file.display());
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/reference_partitions.mjs");
    let output = std::process::Command::new("node")
        .arg(script)
        .arg(repository_root())
        .args(arguments)
        .output()
        .expect("node runs the rewriter");
    assert!(
        output.status.success(),
        "the rewriter failed; install packages/ts first: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

pub fn details_json(error: &narsil::NarsilError) -> Option<String> {
    error
        .details()
        .map(|details| narsil::write_json(&narsil::Value::Object(details.clone())))
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
