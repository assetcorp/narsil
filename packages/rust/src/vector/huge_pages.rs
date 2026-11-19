use std::alloc::{Layout, handle_alloc_error};
use std::ops::Deref;
use std::ptr::{self, NonNull};
use std::sync::atomic::AtomicU32;

pub(crate) struct HugePageFloats {
    start: NonNull<AtomicU32>,
    len: usize,
    held_bytes: usize,
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
        if self.held_bytes > 0 {
            unsafe { backing::release(self.start.cast::<u8>(), self.held_bytes) };
        }
    }
}

fn layout_for(len: usize) -> Layout {
    let Ok(layout) = Layout::array::<AtomicU32>(len) else {
        panic!("a region of {len} floats is larger than the address space");
    };
    layout
}

pub(crate) fn huge_page_floats(len: usize) -> HugePageFloats {
    let layout = layout_for(len);
    if layout.size() == 0 {
        return HugePageFloats {
            start: NonNull::dangling(),
            len,
            held_bytes: 0,
        };
    }
    let Some((start, held_bytes)) = backing::reserve_zeroed(layout) else {
        handle_alloc_error(layout);
    };
    HugePageFloats {
        start: start.cast::<AtomicU32>(),
        len,
        held_bytes,
    }
}

#[cfg(target_os = "linux")]
mod backing {
    use std::alloc::Layout;
    use std::ffi::{c_int, c_void};
    use std::ptr::NonNull;

    const HUGE_PAGE_BYTES: usize = 2 * 1_024 * 1_024;
    const PROT_READ_AND_WRITE: c_int = 0x1 | 0x2;
    const MAP_PRIVATE: c_int = 0x02;
    const MAP_ANONYMOUS: c_int = 0x20;
    const MADV_HUGEPAGE: c_int = 14;
    const NO_FILE: c_int = -1;

    unsafe extern "C" {
        fn mmap(
            start: *mut c_void,
            length: usize,
            protection: c_int,
            flags: c_int,
            file: c_int,
            offset: i64,
        ) -> *mut c_void;
        fn munmap(start: *mut c_void, length: usize) -> c_int;
        fn madvise(start: *mut c_void, length: usize, advice: c_int) -> c_int;
        fn getpagesize() -> c_int;
    }

    fn page_bytes() -> usize {
        usize::try_from(unsafe { getpagesize() })
            .ok()
            .filter(|bytes| bytes.is_power_of_two())
            .unwrap_or(4_096)
    }

    pub(super) fn reserve_zeroed(layout: Layout) -> Option<(NonNull<u8>, usize)> {
        let held_bytes = layout.size().checked_next_multiple_of(page_bytes())?;
        let mapped_bytes = held_bytes.checked_add(HUGE_PAGE_BYTES)?;
        let base = unsafe {
            mmap(
                std::ptr::null_mut(),
                mapped_bytes,
                PROT_READ_AND_WRITE,
                MAP_PRIVATE | MAP_ANONYMOUS,
                NO_FILE,
                0,
            )
        };
        if base.addr() == usize::MAX || base.is_null() {
            return None;
        }
        let leading_bytes = base.addr().next_multiple_of(HUGE_PAGE_BYTES) - base.addr();
        let start = base.wrapping_byte_add(leading_bytes);
        let trailing_bytes = mapped_bytes - leading_bytes - held_bytes;
        unsafe {
            if leading_bytes > 0 {
                munmap(base, leading_bytes);
            }
            if trailing_bytes > 0 {
                munmap(start.wrapping_byte_add(held_bytes), trailing_bytes);
            }
        }
        let whole_huge_pages = held_bytes - held_bytes % HUGE_PAGE_BYTES;
        if whole_huge_pages > 0 {
            unsafe { madvise(start, whole_huge_pages, MADV_HUGEPAGE) };
        }
        NonNull::new(start.cast::<u8>()).map(|start| (start, held_bytes))
    }

    pub(super) unsafe fn release(start: NonNull<u8>, held_bytes: usize) {
        unsafe { munmap(start.as_ptr().cast::<c_void>(), held_bytes) };
    }
}

#[cfg(not(target_os = "linux"))]
mod backing {
    use std::alloc::{Layout, alloc_zeroed, dealloc};
    use std::ptr::NonNull;

    use super::layout_for_bytes;

    pub(super) fn reserve_zeroed(layout: Layout) -> Option<(NonNull<u8>, usize)> {
        NonNull::new(unsafe { alloc_zeroed(layout) }).map(|start| (start, layout.size()))
    }

    pub(super) unsafe fn release(start: NonNull<u8>, held_bytes: usize) {
        unsafe { dealloc(start.as_ptr(), layout_for_bytes(held_bytes)) };
    }
}

#[cfg(not(target_os = "linux"))]
fn layout_for_bytes(bytes: usize) -> Layout {
    layout_for(bytes / size_of::<AtomicU32>())
}
