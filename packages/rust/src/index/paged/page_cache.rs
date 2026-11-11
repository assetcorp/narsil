use crate::ffi;
use crate::index::constants::{PAGE_CACHE_SHARE_PARTS, PAGE_SLOT_METADATA_BYTES};

pub(super) struct PageCache {
    bytes: Vec<u8>,
    files: Vec<u64>,
    offsets: Vec<u64>,
    pages: Vec<u64>,
    lengths: Vec<u32>,
    checksums: Vec<u32>,
}

pub(super) fn slot_bytes() -> usize {
    ffi::NARSIL_PAGE_SLOT_BYTES + PAGE_SLOT_METADATA_BYTES
}

pub(super) fn page_slots_within(capacity: usize) -> usize {
    capacity / PAGE_CACHE_SHARE_PARTS / slot_bytes()
}

impl PageCache {
    pub(super) fn with_slots(slots: usize) -> PageCache {
        PageCache {
            bytes: vec![0; slots * ffi::NARSIL_PAGE_SLOT_BYTES],
            files: vec![0; slots],
            offsets: vec![0; slots],
            pages: vec![0; slots],
            lengths: vec![0; slots],
            checksums: vec![0; slots],
        }
    }

    pub(super) fn raw(&mut self) -> ffi::narsil_page_cache {
        ffi::narsil_page_cache {
            bytes: self.bytes.as_mut_ptr(),
            byte_capacity: self.bytes.len(),
            files: self.files.as_mut_ptr(),
            offsets: self.offsets.as_mut_ptr(),
            pages: self.pages.as_mut_ptr(),
            lengths: self.lengths.as_mut_ptr(),
            checksums: self.checksums.as_mut_ptr(),
            slots: self.files.len(),
        }
    }

    pub(super) fn release(&mut self, identity: u64) {
        for held in &mut self.files {
            if *held == identity {
                *held = 0;
            }
        }
    }
}
