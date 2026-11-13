use std::ffi::{c_char, c_int, c_void};

const MACH_TASK_BASIC_INFO: u32 = 20;
const TASK_VM_INFO: u32 = 22;
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

#[repr(C)]
#[derive(Default)]
struct TaskVmInfoRevisionZero {
    virtual_size: u64,
    region_count: i32,
    page_size: i32,
    resident_size: u64,
    resident_size_peak: u64,
    device: u64,
    device_peak: u64,
    internal: u64,
    internal_peak: u64,
    external: u64,
    external_peak: u64,
    reusable: u64,
    reusable_peak: u64,
    purgeable_volatile_pmap: u64,
    purgeable_volatile_resident: u64,
    purgeable_volatile_virtual: u64,
    compressed: u64,
    compressed_peak: u64,
    compressed_lifetime: u64,
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

fn task_information<T>(flavor: u32, info: &mut T) -> bool {
    let words = std::mem::size_of::<T>() / std::mem::size_of::<u32>();
    let Ok(mut count) = u32::try_from(words) else {
        return false;
    };
    let outcome = unsafe {
        task_info(
            mach_task_self_,
            flavor,
            std::ptr::from_mut(info).cast::<i32>(),
            &raw mut count,
        )
    };
    outcome == KERN_SUCCESS && usize::try_from(count).is_ok_and(|filled| filled >= words)
}

/// Returns the resident memory of this process less the pages that files back, which the task's VM information
/// reports as its `external` memory, and returns the whole resident size where the kernel answers no VM
/// information.
pub(super) fn process_bytes() -> Option<u64> {
    let mut vm = TaskVmInfoRevisionZero::default();
    if task_information(TASK_VM_INFO, &mut vm) && vm.resident_size > 0 {
        return Some(vm.resident_size.saturating_sub(vm.external));
    }
    let mut basic = MachTaskBasicInfo::default();
    task_information(MACH_TASK_BASIC_INFO, &mut basic).then_some(basic.resident_size)
}

/// Returns the machine's memory, which bounds a process on macOS.
pub(super) fn limit_bytes(_process_bytes: u64) -> Option<u64> {
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
