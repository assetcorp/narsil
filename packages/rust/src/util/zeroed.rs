use std::alloc::{Layout, alloc_zeroed, handle_alloc_error};
use std::ptr;
use std::sync::atomic::{AtomicI32, AtomicI64};

pub(crate) trait ValidWhenZeroed {}

impl ValidWhenZeroed for AtomicI64 {}
impl ValidWhenZeroed for AtomicI32 {}

pub(crate) fn zeroed_slice<T: ValidWhenZeroed>(len: usize) -> Box<[T]> {
    if len == 0 {
        return Box::default();
    }
    let Ok(layout) = Layout::array::<T>(len) else {
        panic!("a zeroed region of {len} entries is larger than the address space");
    };
    let start = unsafe { alloc_zeroed(layout) }.cast::<T>();
    if start.is_null() {
        handle_alloc_error(layout);
    }
    unsafe { Box::from_raw(ptr::slice_from_raw_parts_mut(start, len)) }
}
