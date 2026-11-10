use std::ops::Range;

use crate::error::{Result, load_failed};

macro_rules! little_endian_lists {
    ($($kind:ty, $shown:literal, $list:ident, $bytes:ident;)*) => {
        $(
            pub(crate) fn $list(bytes: &[u8], what: &str) -> Result<Vec<$kind>> {
                const WIDTH: usize = std::mem::size_of::<$kind>();
                if bytes.len() % WIDTH != 0 {
                    return load_failed(format!(
                        "{what} holds {} bytes, which is not a whole number of {} values",
                        bytes.len(),
                        $shown
                    ));
                }
                Ok(bytes
                    .chunks_exact(WIDTH)
                    .map(|chunk| {
                        <$kind>::from_le_bytes(<[u8; WIDTH]>::try_from(chunk).unwrap_or_default())
                    })
                    .collect())
            }

            pub(crate) fn $bytes(values: &[$kind]) -> Vec<u8> {
                let mut out = Vec::with_capacity(std::mem::size_of_val(values));
                for value in values {
                    out.extend_from_slice(&value.to_le_bytes());
                }
                out
            }
        )*
    };
}

little_endian_lists! {
    u32, "uint32", u32_list, u32_bytes;
    u16, "uint16", u16_list, u16_bytes;
    u64, "uint64", u64_list, u64_bytes;
    f64, "float64", f64_list, f64_bytes;
    f32, "float32", f32_list, f32_bytes;
}

pub(crate) fn le_u32(bytes: &[u8], at: usize) -> u32 {
    bytes.get(at..at + 4).map_or(0, |raw| {
        u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]])
    })
}

pub(crate) fn offset_range(offsets: &[u32], at: usize) -> Range<usize> {
    let start = offsets.get(at).copied().unwrap_or(0) as usize;
    let end = offsets.get(at + 1).copied().unwrap_or(0) as usize;
    start..end
}

pub(crate) fn offset_entry<'a, T>(values: &'a [T], offsets: &[u32], at: usize) -> &'a [T] {
    values.get(offset_range(offsets, at)).unwrap_or(&[])
}
