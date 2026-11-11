use std::ffi::c_void;

#[repr(C)]
#[derive(Default)]
struct ProcessMemoryCounters {
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
}

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
        counters: *mut ProcessMemoryCounters,
        size: u32,
    ) -> i32;
    fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
}

/// Returns the working set of this process, which Node.js reports as its resident memory on Windows.
pub(super) fn resident_bytes() -> Option<u64> {
    let size = u32::try_from(std::mem::size_of::<ProcessMemoryCounters>()).ok()?;
    let mut counters = ProcessMemoryCounters {
        size,
        ..ProcessMemoryCounters::default()
    };
    let succeeded =
        unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &raw mut counters, size) };
    if succeeded == 0 {
        return None;
    }
    u64::try_from(counters.working_set_size).ok()
}

/// Returns the machine's physical memory, which bounds a process on Windows.
pub(super) fn limit_bytes(_resident: u64) -> Option<u64> {
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
