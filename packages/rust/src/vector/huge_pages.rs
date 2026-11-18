use std::alloc::{Layout, alloc, dealloc, handle_alloc_error};
use std::ops::Deref;
use std::ptr::{self, NonNull};
use std::sync::atomic::AtomicU32;

use super::constants::HUGE_PAGE_BYTES;

#[cfg(target_os = "linux")]
const MADV_HUGEPAGE: i32 = 14;

#[cfg(target_os = "linux")]
unsafe extern "C" {
    fn madvise(start: *mut core::ffi::c_void, length: usize, advice: i32) -> i32;
}

pub(crate) struct HugePageFloats {
    start: NonNull<AtomicU32>,
    len: usize,
    layout: Layout,
}

unsafe impl Send for HugePageFloats {}
unsafe impl Sync for HugePageFloats {}

impl Deref for HugePageFloats {
    type Target = [AtomicU32];

    fn deref(&self) -> &[AtomicU32] {
        unsafe { &*ptr::slice_from_raw_parts(self.start.as_ptr().cast_const(), self.len) }
    }
}

impl Drop for HugePageFloats {
    fn drop(&mut self) {
        if self.layout.size() > 0 {
            unsafe { dealloc(self.start.as_ptr().cast::<u8>(), self.layout) };
        }
    }
}

fn layout_for(len: usize) -> Layout {
    let Ok(plain) = Layout::array::<AtomicU32>(len) else {
        panic!("a region of {len} floats is larger than the address space");
    };
    if plain.size() < HUGE_PAGE_BYTES {
        return plain;
    }
    let Ok(aligned) = plain.align_to(HUGE_PAGE_BYTES) else {
        panic!("a region of {len} floats cannot start on a huge page boundary");
    };
    aligned
}

#[cfg(target_os = "linux")]
fn advise_huge_pages(start: *mut u8, bytes: usize) {
    let whole_pages = bytes - (bytes % HUGE_PAGE_BYTES);
    if whole_pages > 0 {
        let _ = unsafe { madvise(start.cast(), whole_pages, MADV_HUGEPAGE) };
    }
}

#[cfg(not(target_os = "linux"))]
fn advise_huge_pages(_start: *mut u8, _bytes: usize) {}

pub(crate) fn huge_page_floats(len: usize) -> HugePageFloats {
    let layout = layout_for(len);
    if layout.size() == 0 {
        return HugePageFloats {
            start: NonNull::dangling(),
            len,
            layout,
        };
    }
    let raw = unsafe { alloc(layout) };
    if raw.is_null() {
        handle_alloc_error(layout);
    }
    if layout.align() == HUGE_PAGE_BYTES {
        advise_huge_pages(raw, layout.size());
    }
    unsafe { ptr::write_bytes(raw, 0, layout.size()) };
    let Some(start) = NonNull::new(raw.cast::<AtomicU32>()) else {
        handle_alloc_error(layout);
    };
    HugePageFloats { start, len, layout }
}
