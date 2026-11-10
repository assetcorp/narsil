use std::sync::atomic::{AtomicI32, AtomicU8, AtomicU32, AtomicU64, Ordering};

pub(crate) fn words(len: usize, value: i32) -> Box<[AtomicI32]> {
    (0..len).map(|_| AtomicI32::new(value)).collect()
}

pub(crate) fn bytes(len: usize) -> Box<[AtomicU8]> {
    (0..len).map(|_| AtomicU8::new(0)).collect()
}

pub(crate) fn floats(len: usize) -> Box<[AtomicU32]> {
    (0..len).map(|_| AtomicU32::new(0)).collect()
}

pub(crate) fn copied_words(from: &[AtomicI32], len: usize, fill: i32) -> Box<[AtomicI32]> {
    (0..len)
        .map(|at| {
            AtomicI32::new(
                from.get(at)
                    .map_or(fill, |word| word.load(Ordering::Acquire)),
            )
        })
        .collect()
}

pub(crate) fn copied_bytes(from: &[AtomicU8], len: usize) -> Box<[AtomicU8]> {
    (0..len)
        .map(|at| AtomicU8::new(from.get(at).map_or(0, |byte| byte.load(Ordering::Acquire))))
        .collect()
}

pub(crate) fn copied_floats(from: &[AtomicU32], len: usize) -> Box<[AtomicU32]> {
    (0..len)
        .map(|at| AtomicU32::new(from.get(at).map_or(0, |word| word.load(Ordering::Acquire))))
        .collect()
}

pub(crate) fn copied_doubles(from: &[AtomicU64], len: usize) -> Box<[AtomicU64]> {
    (0..len)
        .map(|at| AtomicU64::new(from.get(at).map_or(0, |word| word.load(Ordering::Acquire))))
        .collect()
}

pub(crate) fn word_ptr(words: &[AtomicI32]) -> *mut i32 {
    words.as_ptr().cast::<i32>().cast_mut()
}

pub(crate) fn byte_ptr(bytes: &[AtomicU8]) -> *mut u8 {
    bytes.as_ptr().cast::<u8>().cast_mut()
}

pub(crate) fn float_ptr(words: &[AtomicU32]) -> *mut f32 {
    words.as_ptr().cast::<f32>().cast_mut()
}

pub(crate) fn double_ptr(words: &[AtomicU64]) -> *const f64 {
    words.as_ptr().cast::<f64>()
}

pub(crate) fn unsigned_ptr(words: &[AtomicU32]) -> *const u32 {
    words.as_ptr().cast::<u32>()
}

pub(crate) fn load(words: &[AtomicI32], at: usize) -> i32 {
    words.get(at).map_or(0, |word| word.load(Ordering::Acquire))
}

pub(crate) fn store(words: &[AtomicI32], at: usize, value: i32) {
    if let Some(word) = words.get(at) {
        word.store(value, Ordering::Release);
    }
}

pub(crate) fn load_byte(bytes: &[AtomicU8], at: usize) -> u8 {
    bytes.get(at).map_or(0, |byte| byte.load(Ordering::Acquire))
}

pub(crate) fn store_byte(bytes: &[AtomicU8], at: usize, value: u8) {
    if let Some(byte) = bytes.get(at) {
        byte.store(value, Ordering::Release);
    }
}
