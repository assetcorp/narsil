use std::cell::RefCell;
use std::ptr;
use std::sync::OnceLock;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;

thread_local! {
    static WORKSPACE: RefCell<Option<CoreWorkspace>> = const { RefCell::new(None) };
}

pub(crate) fn with_workspace<T>(
    work: impl FnOnce(*mut ffi::narsil_workspace) -> Result<T>,
) -> Result<T> {
    WORKSPACE.with(|cell| {
        let mut held = cell.try_borrow_mut().map_err(|_| {
            NarsilError::new(
                ErrorCode::INTERNAL_ERROR,
                "A core call made another core call while the first held the thread's workspace",
            )
        })?;
        let workspace = match held.as_ref() {
            Some(workspace) => workspace,
            None => held.insert(CoreWorkspace::create()?),
        };
        work(workspace.handle())
    })
}

fn core_mismatch() -> Option<String> {
    let reported = unsafe { ffi::narsil_core_abi_version() };
    if reported != ffi::NARSIL_CORE_ABI_VERSION {
        return Some(format!(
            "The linked Narsil core reports ABI version {reported}, while this build of delali-narsil needs {}",
            ffi::NARSIL_CORE_ABI_VERSION
        ));
    }
    ffi::layout::core_layout_matches().err().map(|mismatch| {
        format!(
            "The native core and the Rust bindings disagree on the layout of a structure: {mismatch}"
        )
    })
}

fn require_matching_core() -> Result<()> {
    static MISMATCH: OnceLock<Option<String>> = OnceLock::new();
    match MISMATCH.get_or_init(core_mismatch) {
        None => Ok(()),
        Some(message) => Err(NarsilError::new(ErrorCode::INTERNAL_ERROR, message.clone())),
    }
}

/// One workspace of the native core, which holds the scratch memory of the calls that one thread makes.
pub(crate) struct CoreWorkspace {
    handle: *mut ffi::narsil_workspace,
}

impl CoreWorkspace {
    /// Creates a workspace once the linked core reports the ABI version and the structure layouts that the
    /// bindings describe.
    pub(crate) fn create() -> Result<CoreWorkspace> {
        require_matching_core()?;
        let mut handle = ptr::null_mut();
        let status = unsafe { ffi::narsil_workspace_create(&mut handle) };
        if status != ffi::NARSIL_OK || handle.is_null() {
            return Err(NarsilError::new(
                ErrorCode::INTERNAL_ERROR,
                "The native core could not create a workspace, because it ran out of memory",
            ));
        }
        Ok(CoreWorkspace { handle })
    }

    pub(crate) fn handle(&self) -> *mut ffi::narsil_workspace {
        self.handle
    }
}

impl Drop for CoreWorkspace {
    fn drop(&mut self) {
        unsafe { ffi::narsil_workspace_destroy(self.handle) };
    }
}
