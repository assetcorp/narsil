use std::cell::RefCell;
use std::ptr;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;

struct Workspace {
    handle: *mut ffi::narsil_workspace,
}

impl Drop for Workspace {
    fn drop(&mut self) {
        unsafe { ffi::narsil_workspace_destroy(self.handle) };
    }
}

thread_local! {
    static WORKSPACE: RefCell<Option<Workspace>> = const { RefCell::new(None) };
}

pub(crate) fn core_refused(operation: &str, status: ffi::narsil_status) -> NarsilError {
    let code = match status {
        ffi::NARSIL_OUT_OF_MEMORY => ErrorCode::INTERNAL_ERROR,
        ffi::NARSIL_PAGE_CORRUPT => ErrorCode::PERSISTENCE_CRC_MISMATCH,
        ffi::NARSIL_PAGE_UNREADABLE | ffi::NARSIL_PAGE_INVALID => {
            ErrorCode::PERSISTENCE_LOAD_FAILED
        }
        _ => ErrorCode::PARTITION_CORRUPTED,
    };
    NarsilError::new(
        code,
        format!("The native core refused {operation} with status {status}"),
    )
}

pub(crate) fn with_workspace<T>(
    work: impl FnOnce(*mut ffi::narsil_workspace) -> Result<T>,
) -> Result<T> {
    WORKSPACE.with(|cell| {
        let mut held = cell.try_borrow_mut().map_err(|_| {
            NarsilError::new(
                ErrorCode::INTERNAL_ERROR,
                "A keyword write called back into the engine while the native core held its workspace",
            )
        })?;
        if held.is_none() {
            let mut handle = ptr::null_mut();
            let status = unsafe { ffi::narsil_workspace_create(&mut handle) };
            if status != ffi::NARSIL_OK || handle.is_null() {
                return Err(core_refused("a workspace", ffi::NARSIL_OUT_OF_MEMORY));
            }
            *held = Some(Workspace { handle });
        }
        match held.as_ref() {
            Some(workspace) => work(workspace.handle),
            None => Err(core_refused("a workspace", ffi::NARSIL_OUT_OF_MEMORY)),
        }
    })
}
