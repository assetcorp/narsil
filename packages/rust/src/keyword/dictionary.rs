use std::ptr;

use super::constants::{LOOKUP_START_CAPACITY, MAX_ROOM_ATTEMPTS};
use super::growing::GrowingRead;
use crate::error::Result;
use crate::ffi;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::native::status::core_refused;
use crate::native::workspace::with_workspace;

pub(crate) enum Dictionary {
    Growing(Box<GrowingRead>),
    Frozen(ffi::narsil_term_dictionary, Option<Vec<u32>>),
}

unsafe impl Send for Dictionary {}
unsafe impl Sync for Dictionary {}

fn empty_dictionary() -> ffi::narsil_term_dictionary {
    ffi::narsil_term_dictionary {
        growing: ptr::null(),
        tokens: ptr::null(),
        token_bytes: 0,
        offsets: ptr::null(),
        offset_count: 0,
        frequencies: ptr::null(),
        frequency_count: 0,
        removed: ptr::null(),
        removed_count: 0,
    }
}

impl Dictionary {
    pub(crate) fn of(entry: &SegmentEntry) -> Dictionary {
        match &entry.data {
            SegmentData::Tail(tail) => Dictionary::Growing(tail.keyword.read()),
            SegmentData::Frozen(segment) => {
                let payload = &segment.payload;
                let frequency_count = payload.document_frequencies.len();
                let held = entry
                    .state
                    .as_ref()
                    .map(|state| state.removed_documents())
                    .filter(|removed| removed.len() == frequency_count);
                let mut dictionary = empty_dictionary();
                dictionary.tokens = payload.tokens.as_ptr();
                dictionary.token_bytes = payload.tokens.len();
                dictionary.offsets = payload.token_offsets.as_ptr();
                dictionary.offset_count = payload.token_offsets.len();
                dictionary.frequencies = payload.document_frequencies.as_ptr();
                dictionary.frequency_count = frequency_count;
                match held {
                    Some(removed) => {
                        dictionary.removed = removed.as_ptr();
                        dictionary.removed_count = removed.len();
                        Dictionary::Frozen(dictionary, None)
                    }
                    None => Dictionary::Frozen(dictionary, Some(vec![0u32; frequency_count])),
                }
            }
        }
    }

    fn raw(&self) -> ffi::narsil_term_dictionary {
        match self {
            Dictionary::Growing(read) => read.dictionary(),
            Dictionary::Frozen(dictionary, zeros) => {
                let mut raw = *dictionary;
                if let Some(zeros) = zeros {
                    raw.removed = zeros.as_ptr();
                    raw.removed_count = zeros.len();
                }
                raw
            }
        }
    }

    fn lookup(
        &self,
        text: &[u16],
        operation: u32,
        limit: u32,
        tolerance: u32,
        prefix_length: u32,
    ) -> Result<Vec<u32>> {
        let dictionary = self.raw();
        let request = ffi::narsil_term_lookup {
            dictionary: &dictionary,
            text: text.as_ptr(),
            text_length: text.len(),
            operation,
            limit,
            tolerance,
            prefix_length,
        };
        let mut ordinals = vec![0u32; LOOKUP_START_CAPACITY];
        for _ in 0..MAX_ROOM_ATTEMPTS {
            let mut count = 0u32;
            let status = with_workspace(|workspace| {
                Ok(unsafe {
                    ffi::narsil_lookup_terms(
                        workspace,
                        &request,
                        ordinals.as_mut_ptr(),
                        ordinals.len(),
                        &mut count,
                    )
                })
            })?;
            match status {
                ffi::NARSIL_OK => {
                    ordinals.truncate(count as usize);
                    return Ok(ordinals);
                }
                ffi::NARSIL_NEEDS_ROOM => {
                    let grown = ordinals.len() * 2;
                    ordinals.resize(grown, 0);
                }
                status => return Err(core_refused("a term lookup", status)),
            }
        }
        Err(core_refused("a term lookup", ffi::NARSIL_NEEDS_ROOM))
    }

    pub(crate) fn exact(&self, text: &[u16]) -> Result<Option<u32>> {
        Ok(self
            .lookup(text, ffi::NARSIL_LOOKUP_EXACT, 0, 0, 0)?
            .first()
            .copied())
    }

    pub(crate) fn typo(
        &self,
        text: &[u16],
        tolerance: u32,
        prefix_length: u32,
    ) -> Result<Vec<u32>> {
        self.lookup(text, ffi::NARSIL_LOOKUP_TYPO, 0, tolerance, prefix_length)
    }

    pub(crate) fn document_frequency(&self, token: u32) -> Result<u32> {
        let dictionary = self.raw();
        let mut frequency = 0u32;
        let status =
            unsafe { ffi::narsil_document_frequency(&dictionary, token, &mut frequency, 1) };
        if status != ffi::NARSIL_OK {
            return Err(core_refused("a document frequency", status));
        }
        Ok(frequency)
    }
}
