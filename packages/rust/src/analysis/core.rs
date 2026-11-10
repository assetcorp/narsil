use std::cell::RefCell;
use std::ffi::CStr;
use std::ptr;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;

pub(crate) struct TokenParts<'a> {
    pub(crate) term: &'a [u16],
    pub(crate) position: u32,
    pub(crate) surface: Option<&'a [u16]>,
    pub(crate) original: &'a [u16],
}

struct Analyser {
    handle: *mut ffi::narsil_analyser,
    units: Vec<u16>,
}

impl Drop for Analyser {
    fn drop(&mut self) {
        unsafe { ffi::narsil_analyser_destroy(self.handle) };
    }
}

fn created_analyser() -> Result<Analyser> {
    let mut handle = ptr::null_mut();
    let status = unsafe { ffi::narsil_analyser_create(&mut handle) };
    if status != ffi::NARSIL_OK || handle.is_null() {
        return Err(NarsilError::new(
            ErrorCode::CONFIG_INVALID,
            "The native core could not create a text analyser, because it ran out of memory",
        ));
    }
    Ok(Analyser {
        handle,
        units: Vec::new(),
    })
}

thread_local! {
    static ANALYSER: RefCell<Option<Analyser>> = const { RefCell::new(None) };
}

fn with_analyser<T>(work: impl FnOnce(&mut Analyser) -> Result<T>) -> Result<T> {
    ANALYSER.with(|cell| {
        let mut held = cell.try_borrow_mut().map_err(|_| {
            NarsilError::new(
                ErrorCode::CONFIG_INVALID,
                "A tokenizer or stop word function called back into the engine while the engine analysed its text",
            )
        })?;
        if held.is_none() {
            *held = Some(created_analyser()?);
        }
        match held.as_mut() {
            Some(analyser) => work(analyser),
            None => unreachable!(),
        }
    })
}

pub(crate) fn with_core_analyser<T>(
    work: impl FnOnce(*mut ffi::narsil_analyser) -> Result<T>,
) -> Result<T> {
    with_analyser(|analyser| work(analyser.handle))
}

/// The stop words that the native core tests each token against.
pub(crate) struct CoreStopWords {
    handle: *mut ffi::narsil_stop_word_set,
}

unsafe impl Send for CoreStopWords {}
unsafe impl Sync for CoreStopWords {}

impl Drop for CoreStopWords {
    fn drop(&mut self) {
        unsafe { ffi::narsil_stop_word_set_destroy(self.handle) };
    }
}

impl CoreStopWords {
    pub(crate) fn of<'a>(words: impl Iterator<Item = &'a str>) -> Result<CoreStopWords> {
        let mut units: Vec<u16> = Vec::new();
        let mut offsets: Vec<u32> = vec![0];
        for word in words {
            units.extend(word.encode_utf16());
            let end = u32::try_from(units.len()).map_err(|_| too_many_stop_words())?;
            offsets.push(end);
        }
        let count = u32::try_from(offsets.len() - 1).map_err(|_| too_many_stop_words())?;
        let mut handle = ptr::null_mut();
        let status = unsafe {
            ffi::narsil_stop_word_set_create(units.as_ptr(), offsets.as_ptr(), count, &mut handle)
        };
        if status != ffi::NARSIL_OK || handle.is_null() {
            return Err(too_many_stop_words());
        }
        Ok(CoreStopWords { handle })
    }
}

fn too_many_stop_words() -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        "The stop word set holds more words than the native core accepts",
    )
}

fn text_too_long() -> NarsilError {
    NarsilError::new(
        ErrorCode::DOC_VALIDATION_FAILED,
        "The text holds more than 1,073,741,824 UTF-16 code units, which is more than the engine analyses",
    )
}

pub(crate) fn language_index(name: &str) -> Option<u32> {
    let mut index = 0u32;
    let status =
        unsafe { ffi::narsil_language_lookup(name.as_ptr().cast(), name.len(), &mut index) };
    (status == ffi::NARSIL_OK).then_some(index)
}

fn static_text(pointer: *const std::ffi::c_char) -> &'static str {
    if pointer.is_null() {
        return "";
    }
    unsafe { CStr::from_ptr(pointer) }.to_str().unwrap_or("")
}

pub(crate) fn language_name(index: u32) -> &'static str {
    static_text(unsafe { ffi::narsil_language_name(index) })
}

pub(crate) fn language_revision(index: u32) -> &'static str {
    static_text(unsafe { ffi::narsil_language_revision(index) })
}

pub(crate) fn language_count() -> u32 {
    unsafe { ffi::narsil_language_count() }
}

pub(crate) fn language_stop_words(index: u32) -> Vec<String> {
    let mut list = ffi::narsil_word_list {
        units: ptr::null(),
        offsets: ptr::null(),
        count: 0,
    };
    let status = unsafe { ffi::narsil_language_stop_words(index, &mut list) };
    if status != ffi::NARSIL_OK || list.count == 0 || list.offsets.is_null() {
        return Vec::new();
    }
    let offsets = unsafe { std::slice::from_raw_parts(list.offsets, list.count as usize + 1) };
    let total = offsets[list.count as usize] as usize;
    let units = if total == 0 || list.units.is_null() {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(list.units, total) }
    };
    offsets
        .windows(2)
        .map(|pair| String::from_utf16_lossy(&units[pair[0] as usize..pair[1] as usize]))
        .collect()
}

fn request_of(
    language: u32,
    stop_words: Option<&CoreStopWords>,
    flags: u32,
    units: &[u16],
) -> Result<ffi::narsil_analysis_request> {
    let length = u32::try_from(units.len()).map_err(|_| text_too_long())?;
    if length > ffi::NARSIL_MAX_ANALYSED_UNITS {
        return Err(text_too_long());
    }
    Ok(ffi::narsil_analysis_request {
        language,
        stop_words: stop_words.map_or(ptr::null(), |set| set.handle.cast_const()),
        flags,
        text: units.as_ptr(),
        length,
    })
}

fn span(units: &[u16], offset: u32, length: u32) -> &[u16] {
    let start = offset as usize;
    let end = start.saturating_add(length as usize);
    units.get(start..end).unwrap_or(&[])
}

pub(crate) fn analyse(
    language: u32,
    stop_words: Option<&CoreStopWords>,
    flags: u32,
    text: &str,
    visit: &mut dyn FnMut(TokenParts<'_>),
) -> Result<()> {
    with_analyser(|analyser| {
        analyser.units.clear();
        analyser.units.extend(text.encode_utf16());
        let request = request_of(language, stop_words, flags, &analyser.units)?;
        let mut tokens = ffi::narsil_tokens {
            tokens: ptr::null(),
            token_count: 0,
            units: ptr::null(),
            unit_count: 0,
        };
        let status = unsafe { ffi::narsil_analyse(analyser.handle, &request, &mut tokens) };
        if status != ffi::NARSIL_OK {
            return Err(text_too_long());
        }
        if tokens.token_count == 0 || tokens.tokens.is_null() {
            return Ok(());
        }
        let records =
            unsafe { std::slice::from_raw_parts(tokens.tokens, tokens.token_count as usize) };
        let units = if tokens.unit_count == 0 || tokens.units.is_null() {
            &[][..]
        } else {
            unsafe { std::slice::from_raw_parts(tokens.units, tokens.unit_count as usize) }
        };
        for record in records {
            let surface = (record.surface_offset != ffi::NARSIL_NO_SURFACE)
                .then(|| span(units, record.surface_offset, record.surface_length));
            visit(TokenParts {
                term: span(units, record.term_offset, record.term_length),
                position: record.position,
                surface,
                original: span(units, record.original_offset, record.original_length),
            });
        }
        Ok(())
    })
}

pub(crate) fn transform(language: u32, flags: u32, raw: &str) -> Result<String> {
    with_analyser(|analyser| {
        analyser.units.clear();
        analyser.units.extend(raw.encode_utf16());
        let request = request_of(language, None, flags, &analyser.units)?;
        let mut term = ffi::narsil_term {
            units: ptr::null(),
            length: 0,
        };
        let status = unsafe { ffi::narsil_transform(analyser.handle, &request, &mut term) };
        if status != ffi::NARSIL_OK {
            return Err(text_too_long());
        }
        if term.length == 0 || term.units.is_null() {
            return Ok(String::new());
        }
        let units = unsafe { std::slice::from_raw_parts(term.units, term.length as usize) };
        Ok(String::from_utf16_lossy(units))
    })
}
