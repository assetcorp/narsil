use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;

pub(crate) fn refused_as(
    code: ErrorCode,
    operation: &str,
    status: ffi::narsil_status,
) -> NarsilError {
    NarsilError::new(
        code,
        format!("The native core refused {operation} with status {status}"),
    )
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
    refused_as(code, operation, status)
}

pub(crate) fn core_failed(status: ffi::narsil_status, operation: &str) -> NarsilError {
    let reason = match status {
        ffi::NARSIL_OUT_OF_MEMORY => "it ran out of memory",
        ffi::NARSIL_NEEDS_ROOM => "the field had no room for the vector",
        ffi::NARSIL_GRAPH_NOT_HELD_ALONE => "another thread held the graph",
        ffi::NARSIL_FILE_UNREADABLE => "it could not read a vector file",
        _ => "it refused the arguments",
    };
    NarsilError::new(
        ErrorCode::INTERNAL_ERROR,
        format!("The native core could not {operation}, because {reason}"),
    )
}

pub(crate) fn query_refused(operation: &str, status: ffi::narsil_status) -> NarsilError {
    refused_as(ErrorCode::CONFIG_INVALID, operation, status)
}

pub(crate) fn query_accepted(operation: &str, status: ffi::narsil_status) -> Result<()> {
    match status {
        ffi::NARSIL_OK => Ok(()),
        refusal => Err(query_refused(operation, refusal)),
    }
}
