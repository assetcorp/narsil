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
