use std::cell::RefCell;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::native::workspace::CoreWorkspace;

thread_local! {
    static WORKSPACE: RefCell<Option<CoreWorkspace>> = const { RefCell::new(None) };
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
        let workspace = match held.as_ref() {
            Some(workspace) => workspace,
            None => held.insert(CoreWorkspace::create()?),
        };
        work(workspace.handle())
    })
}
