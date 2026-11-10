use crate::error::{Result, load_failed};

pub(crate) fn u32_list(bytes: &[u8], what: &str) -> Result<Vec<u32>> {
    if bytes.len() % 4 != 0 {
        return load_failed(format!(
            "{what} holds {} bytes, which is not a whole number of uint32 values",
            bytes.len()
        ));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

pub(crate) fn u16_list(bytes: &[u8], what: &str) -> Result<Vec<u16>> {
    if bytes.len() % 2 != 0 {
        return load_failed(format!(
            "{what} holds {} bytes, which is not a whole number of uint16 values",
            bytes.len()
        ));
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect())
}

pub(crate) fn u64_list(bytes: &[u8], what: &str) -> Result<Vec<u64>> {
    if bytes.len() % 8 != 0 {
        return load_failed(format!(
            "{what} holds {} bytes, which is not a whole number of uint64 values",
            bytes.len()
        ));
    }
    Ok(bytes
        .chunks_exact(8)
        .map(|chunk| u64::from_le_bytes(chunk.try_into().unwrap_or([0; 8])))
        .collect())
}

pub(crate) fn f64_list(bytes: &[u8], what: &str) -> Result<Vec<f64>> {
    if bytes.len() % 8 != 0 {
        return load_failed(format!(
            "{what} holds {} bytes, which is not a whole number of float64 values",
            bytes.len()
        ));
    }
    Ok(bytes
        .chunks_exact(8)
        .map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap_or([0; 8])))
        .collect())
}

pub(crate) fn f32_list(bytes: &[u8], what: &str) -> Result<Vec<f32>> {
    if bytes.len() % 4 != 0 {
        return load_failed(format!(
            "{what} holds {} bytes, which is not a whole number of float32 values",
            bytes.len()
        ));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

pub(crate) fn u32_bytes(values: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len() * 4);
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

pub(crate) fn u16_bytes(values: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len() * 2);
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

pub(crate) fn u64_bytes(values: &[u64]) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len() * 8);
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

pub(crate) fn f64_bytes(values: &[f64]) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len() * 8);
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

pub(crate) fn f32_bytes(values: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len() * 4);
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}
