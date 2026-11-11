use crate::ffi;

pub(crate) const ABSENT_TERM: u32 = u32::MAX;

pub(crate) fn lookup_exact_batch(
    workspace: *mut ffi::narsil_workspace,
    dictionary: &ffi::narsil_term_dictionary,
    units: &[u16],
    offsets: &[u32],
    ordinals: &mut [u32],
) -> std::result::Result<usize, ffi::narsil_status> {
    let status = unsafe {
        ffi::narsil_lookup_exact_batch(
            workspace,
            dictionary,
            units.as_ptr(),
            units.len(),
            offsets.as_ptr(),
            offsets.len(),
            ordinals.as_mut_ptr(),
            ordinals.len(),
        )
    };
    if status != ffi::NARSIL_OK {
        return Err(status);
    }
    Ok(offsets.len() - 1)
}
