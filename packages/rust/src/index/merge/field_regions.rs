use std::ptr;

use super::inputs::MergeInput;
use crate::error::Result;
use crate::ffi;
use crate::native::status::core_refused;
use crate::native::workspace::with_workspace;

const REGIONS: usize = ffi::NARSIL_FIELD_MERGE_REGIONS;

pub(super) static EMPTY_OFFSETS: [u32; 1] = [0];

const NO_SOURCE_REGION: ffi::narsil_field_merge_region = ffi::narsil_field_merge_region {
    data: ptr::null(),
    length: 0,
};

const NO_TARGET_REGION: ffi::narsil_field_merge_target = ffi::narsil_field_merge_target {
    data: ptr::null_mut(),
    capacity: 0,
};

pub(super) type RegionLengths = [u32; REGIONS];

pub(super) trait FieldTargets: Sized {
    fn sized(lengths: &RegionLengths) -> Self;
    fn targets(&mut self) -> Vec<ffi::narsil_field_merge_target>;
}

pub(super) fn source_region<T>(values: &[T]) -> ffi::narsil_field_merge_region {
    ffi::narsil_field_merge_region {
        data: values.as_ptr().cast(),
        length: values.len(),
    }
}

pub(super) fn target_region<T>(values: &mut [T]) -> ffi::narsil_field_merge_target {
    ffi::narsil_field_merge_target {
        data: values.as_mut_ptr().cast(),
        capacity: values.len(),
    }
}

pub(super) fn region_length(lengths: &RegionLengths, at: usize) -> usize {
    lengths.get(at).copied().unwrap_or(0) as usize
}

pub(super) fn field_source(
    input: &MergeInput<'_>,
    regions: &[ffi::narsil_field_merge_region],
) -> ffi::narsil_field_merge_source {
    let mut held = [NO_SOURCE_REGION; REGIONS];
    for (slot, region) in held.iter_mut().zip(regions) {
        *slot = *region;
    }
    ffi::narsil_field_merge_source {
        mapping: input.remap.as_ptr(),
        document_count: input.remap.len(),
        regions: held,
    }
}

pub(super) fn merge_field_regions<T: FieldTargets>(
    kind: u32,
    sources: &[ffi::narsil_field_merge_source],
    document_count: u32,
) -> Result<T> {
    let request = ffi::narsil_field_merge_request {
        kind,
        document_count,
        sources: sources.as_ptr(),
        source_count: sources.len(),
    };
    let mut sizes = ffi::narsil_field_merge_sizes::default();
    let measured = with_workspace(|workspace| {
        Ok(unsafe { ffi::narsil_measure_field_merge(workspace, &request, &mut sizes) })
    })?;
    if measured != ffi::NARSIL_OK {
        return Err(core_refused("a field merge", measured));
    }
    let mut merged = T::sized(&sizes.lengths);
    let mut output = ffi::narsil_field_merge_output {
        regions: [NO_TARGET_REGION; REGIONS],
    };
    for (slot, target) in output.regions.iter_mut().zip(merged.targets()) {
        *slot = target;
    }
    let written = with_workspace(|workspace| {
        Ok(unsafe { ffi::narsil_write_field_merge(workspace, &request, &output) })
    })?;
    if written != ffi::NARSIL_OK {
        return Err(core_refused("a field merge", written));
    }
    Ok(merged)
}
