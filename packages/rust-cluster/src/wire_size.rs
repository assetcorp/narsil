use crate::constants::{
    MAX_FORWARD_BATCH_OPERATIONS, MAX_WIRE_BATCH_BYTES, WIRE_BATCH_OVERHEAD_BYTES,
};

pub(crate) fn str_len(length: usize) -> usize {
    let header = if length < 32 {
        1
    } else if length < 0x100 {
        2
    } else if length < 0x1_0000 {
        3
    } else {
        5
    };
    header + length
}

pub(crate) fn bin_len(length: usize) -> usize {
    let header = if length < 0x100 {
        2
    } else if length < 0x1_0000 {
        3
    } else {
        5
    };
    header + length
}

pub(crate) fn uint_len(number: u64) -> usize {
    if number < 0x80 {
        1
    } else if number < 0x100 {
        2
    } else if number < 0x1_0000 {
        3
    } else if number < 0x1_0000_0000 {
        5
    } else {
        9
    }
}

pub(crate) const FIXMAP_HEADER_BYTES: usize = 1;

pub(crate) fn wire_batches<T>(
    items: &[T],
    document_bytes: impl Fn(&T) -> usize,
    follows: impl Fn(&T, &T) -> bool,
) -> Vec<&[T]> {
    let mut batches = Vec::new();
    let (mut start, mut bytes) = (0, 0);
    for (at, item) in items.iter().enumerate() {
        let item_bytes = document_bytes(item) + WIRE_BATCH_OVERHEAD_BYTES;
        let count = at - start;
        let breaks_run = count > 0 && !follows(&items[at - 1], item);
        let overflows = count >= MAX_FORWARD_BATCH_OPERATIONS
            || (count > 0 && bytes + item_bytes > MAX_WIRE_BATCH_BYTES);
        if breaks_run || overflows {
            batches.push(&items[start..at]);
            (start, bytes) = (at, 0);
        }
        bytes += item_bytes;
    }
    if start < items.len() {
        batches.push(&items[start..]);
    }
    batches
}
