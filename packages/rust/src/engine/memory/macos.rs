use std::ffi::{c_char, c_int, c_void};

const MACH_TASK_BASIC_INFO: u32 = 20;
const KERN_SUCCESS: c_int = 0;
const HOST_MEMORY_NAME: &[u8] = b"hw.memsize\0";

#[repr(C)]
#[derive(Default)]
struct TimeValue {
    seconds: i32,
    microseconds: i32,
}

#[repr(C)]
#[derive(Default)]
struct MachTaskBasicInfo {
    virtual_size: u64,
    resident_size: u64,
    resident_size_max: u64,
    user_time: TimeValue,
    system_time: TimeValue,
    policy: i32,
    suspend_count: i32,
}

unsafe extern "C" {
    static mach_task_self_: u32;
    fn task_info(target: u32, flavor: u32, info: *mut i32, count: *mut u32) -> c_int;
    fn sysctlbyname(
        name: *const c_char,
        old: *mut c_void,
        old_length: *mut usize,
        new: *mut c_void,
        new_length: usize,
    ) -> c_int;
}

/// Returns the resident size of this process from the Mach task's basic information.
pub(super) fn resident_bytes() -> Option<u64> {
    let mut info = MachTaskBasicInfo::default();
    let words = std::mem::size_of::<MachTaskBasicInfo>() / std::mem::size_of::<u32>();
    let mut count = u32::try_from(words).ok()?;
    let outcome = unsafe {
        task_info(
            mach_task_self_,
            MACH_TASK_BASIC_INFO,
            (&raw mut info).cast::<i32>(),
            &raw mut count,
        )
    };
    (outcome == KERN_SUCCESS).then_some(info.resident_size)
}

/// Returns the machine's memory, which bounds a process on macOS.
pub(super) fn limit_bytes(_resident: u64) -> Option<u64> {
    let mut bytes: u64 = 0;
    let mut length = std::mem::size_of::<u64>();
    let outcome = unsafe {
        sysctlbyname(
            HOST_MEMORY_NAME.as_ptr().cast::<c_char>(),
            (&raw mut bytes).cast::<c_void>(),
            &raw mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    (outcome == 0 && bytes > 0).then_some(bytes)
}

pub(super) fn release_free_pages() -> bool {
    false
}
