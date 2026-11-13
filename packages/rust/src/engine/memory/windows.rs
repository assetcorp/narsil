use std::ffi::c_void;

#[repr(C)]
#[derive(Default)]
struct ProcessMemoryCountersEx2 {
    size: u32,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
    private_usage: usize,
    private_working_set_size: usize,
    shared_commit_usage: u64,
}

const PROCESS_MEMORY_COUNTERS_BYTES: usize =
    std::mem::offset_of!(ProcessMemoryCountersEx2, private_usage);

#[repr(C)]
#[derive(Default)]
struct MemoryStatus {
    length: u32,
    memory_load: u32,
    total_physical: u64,
    available_physical: u64,
    total_page_file: u64,
    available_page_file: u64,
    total_virtual: u64,
    available_virtual: u64,
    available_extended_virtual: u64,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
    fn K32GetProcessMemoryInfo(
        process: *mut c_void,
        counters: *mut ProcessMemoryCountersEx2,
        size: u32,
    ) -> i32;
    fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
}

fn memory_counters(bytes: usize) -> Option<ProcessMemoryCountersEx2> {
    let size = u32::try_from(bytes).ok()?;
    let mut counters = ProcessMemoryCountersEx2 {
        size,
        ..ProcessMemoryCountersEx2::default()
    };
    let succeeded =
        unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &raw mut counters, size) };
    (succeeded != 0).then_some(counters)
}

/// Returns the private working set of this process, which leaves out the pages that files back, and returns the
/// whole working set on a Windows release that reports no private working set.
pub(super) fn process_bytes() -> Option<u64> {
    let counters = memory_counters(std::mem::size_of::<ProcessMemoryCountersEx2>())
        .or_else(|| memory_counters(PROCESS_MEMORY_COUNTERS_BYTES))?;
    let bytes = match counters.private_working_set_size {
        0 => counters.working_set_size,
        private => private,
    };
    u64::try_from(bytes).ok()
}

/// Returns the machine's physical memory, which bounds a process on Windows.
pub(super) fn limit_bytes(_process_bytes: u64) -> Option<u64> {
    let mut status = MemoryStatus {
        length: u32::try_from(std::mem::size_of::<MemoryStatus>()).ok()?,
        ..MemoryStatus::default()
    };
    let succeeded = unsafe { GlobalMemoryStatusEx(&raw mut status) };
    (succeeded != 0 && status.total_physical > 0).then_some(status.total_physical)
}

pub(super) fn release_free_pages() -> bool {
    false
}
