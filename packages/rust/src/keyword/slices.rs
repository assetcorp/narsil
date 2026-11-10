use std::sync::OnceLock;

use super::constants::{
    POOL_GROWTH_DENOMINATOR, POOL_GROWTH_NUMERATOR, SLICE_GROWTH_DENOMINATOR,
    SLICE_GROWTH_NUMERATOR,
};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;

pub(crate) const NO_FREE_SLICE: u32 = u32::MAX;
pub(crate) const ALLOCATION_END: usize = 0;
pub(crate) const ALLOCATION_FREE: usize = 1;
const ALLOCATION_WORDS: usize = 2;
pub(crate) const MAX_POOL_ENTRIES: usize = u32::MAX as usize;

pub(crate) fn slice_capacities() -> &'static [u32] {
    static CAPACITIES: OnceLock<Vec<u32>> = OnceLock::new();
    CAPACITIES.get_or_init(|| {
        let mut capacities = vec![1u32];
        let mut previous = 1u64;
        while previous < u64::from(u32::MAX) {
            let grown = (previous * SLICE_GROWTH_NUMERATOR).div_ceil(SLICE_GROWTH_DENOMINATOR);
            previous = grown.max(previous + 1).min(u64::from(u32::MAX));
            capacities.push(previous as u32);
        }
        capacities
    })
}

pub(crate) fn region_full(what: &str) -> NarsilError {
    NarsilError::new(
        ErrorCode::PARTITION_CORRUPTED,
        format!("The keyword segment's {what} outgrew its uint32 address space"),
    )
}

pub(crate) fn grown_capacity(current: usize, needed: usize, most: usize) -> Result<usize> {
    if needed > most {
        return Err(region_full("pools"));
    }
    let grown = (current * POOL_GROWTH_NUMERATOR).div_ceil(POOL_GROWTH_DENOMINATOR);
    Ok(needed.max(grown.min(most)))
}

pub(crate) fn grow_to<T: Copy + Default>(values: &mut Vec<T>, capacity: usize) {
    if capacity > values.len() {
        values.resize(capacity, T::default());
    }
}

pub(crate) fn trim_to<T>(values: &mut Vec<T>, length: usize) {
    if length < values.len() {
        values.truncate(length);
        values.shrink_to_fit();
    }
}

#[derive(Clone)]
pub(crate) struct SliceAllocator {
    allocation: Box<[u32; ALLOCATION_WORDS]>,
    free_heads: Box<[u32]>,
}

impl SliceAllocator {
    pub(crate) fn new(first_end: u32) -> SliceAllocator {
        SliceAllocator {
            allocation: Box::new([first_end, 0]),
            free_heads: vec![NO_FREE_SLICE; slice_capacities().len()].into_boxed_slice(),
        }
    }

    pub(crate) fn end(&self) -> usize {
        self.allocation[ALLOCATION_END] as usize
    }

    pub(crate) fn free_entries(&self) -> usize {
        self.allocation[ALLOCATION_FREE] as usize
    }

    pub(crate) fn raw(&mut self) -> ffi::narsil_slice_allocator {
        let capacities = slice_capacities();
        ffi::narsil_slice_allocator {
            allocation: self.allocation.as_mut_ptr(),
            free_heads: self.free_heads.as_mut_ptr(),
            slice_capacities: capacities.as_ptr(),
            class_count: capacities.len(),
        }
    }

    pub(crate) fn view(&self) -> ffi::narsil_slice_allocator {
        let capacities = slice_capacities();
        ffi::narsil_slice_allocator {
            allocation: self.allocation.as_ptr().cast_mut(),
            free_heads: self.free_heads.as_ptr().cast_mut(),
            slice_capacities: capacities.as_ptr(),
            class_count: capacities.len(),
        }
    }

    pub(crate) fn bytes(&self) -> usize {
        (ALLOCATION_WORDS + self.free_heads.len()) * size_of::<u32>()
    }
}
