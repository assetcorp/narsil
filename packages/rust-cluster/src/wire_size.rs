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

#[derive(Default)]
pub(crate) struct WireBatchBound {
    count: usize,
    bytes: usize,
}

impl WireBatchBound {
    pub(crate) fn takes(&mut self, document_bytes: usize, follows_previous: bool) -> bool {
        let item_bytes = document_bytes.saturating_add(WIRE_BATCH_OVERHEAD_BYTES);
        let full = !follows_previous
            || self.count >= MAX_FORWARD_BATCH_OPERATIONS
            || self.bytes.saturating_add(item_bytes) > MAX_WIRE_BATCH_BYTES;
        if self.count > 0 && full {
            return false;
        }
        self.count += 1;
        self.bytes = self.bytes.saturating_add(item_bytes);
        true
    }
}

pub(crate) fn wire_batches<T>(
    items: &[T],
    document_bytes: impl Fn(&T) -> usize,
    follows: impl Fn(&T, &T) -> bool,
) -> Vec<&[T]> {
    let mut batches = Vec::new();
    let mut start = 0;
    let mut bound = WireBatchBound::default();
    let mut previous: Option<&T> = None;
    for (at, item) in items.iter().enumerate() {
        let follows_previous = previous.is_none_or(|previous| follows(previous, item));
        if !bound.takes(document_bytes(item), follows_previous) {
            batches.push(&items[start..at]);
            start = at;
            bound = WireBatchBound::default();
            bound.takes(document_bytes(item), true);
        }
        previous = Some(item);
    }
    if start < items.len() {
        batches.push(&items[start..]);
    }
    batches
}
