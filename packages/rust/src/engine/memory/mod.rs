mod bound;
mod budget;
pub(crate) mod constants;
mod guard;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod parse;
mod projection;
#[cfg(windows)]
mod windows;

pub(crate) use budget::{require_analysis_rebuild_memory, require_restore_memory};
pub(crate) use guard::MemoryGuard;
pub use parse::{ParseKind, ParseShortfall};
pub(crate) use projection::{WriteProjection, refused_after, reserve_for_document};

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;

/// The resident memory of this process that no file backs, and the memory that it may use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProcessMemory {
    pub(crate) process_bytes: u64,
    pub(crate) limit_bytes: u64,
}

impl ProcessMemory {
    fn fraction(&self) -> f64 {
        self.process_bytes as f64 / self.limit_bytes as f64
    }
}

/// Reads the resident memory of this process that no file backs and its limit, or returns `None` on a system that
/// reports neither.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub(crate) fn read_process_memory() -> Option<ProcessMemory> {
    let process_bytes = platform::process_bytes()?;
    let limit_bytes = platform::limit_bytes(process_bytes).filter(|bytes| *bytes > 0)?;
    Some(ProcessMemory {
        process_bytes,
        limit_bytes,
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn read_process_memory() -> Option<ProcessMemory> {
    None
}

/// Reads the whole resident memory of this process, file-backed pages included, or returns `None` on a system
/// that reports none.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub(crate) fn read_resident_bytes() -> Option<u64> {
    platform::resident_bytes()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn read_resident_bytes() -> Option<u64> {
    None
}

/// Hands the allocator's free pages back to the system where the allocator allows it, and reports whether any
/// went back.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub(crate) fn release_free_pages() -> bool {
    platform::release_free_pages()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn release_free_pages() -> bool {
    false
}
