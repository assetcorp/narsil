use super::constants::MAX_FOLD_CODE_POINTS;
use crate::error::Result;
use crate::ffi;
use crate::native::status::core_refused;

const MAX_UNITS_PER_CODE_POINT: usize = 2;

fn append_folded_units(units: &[u16], out: &mut Vec<u32>) -> Result<()> {
    if units.is_empty() {
        return Ok(());
    }
    let before = out.len();
    out.resize(before + units.len() * MAX_FOLD_CODE_POINTS, 0);
    let room = &mut out[before..];
    let mut count = 0u32;
    let status = unsafe {
        ffi::narsil_case_fold(
            units.as_ptr(),
            units.len(),
            room.as_mut_ptr(),
            room.len(),
            &mut count,
        )
    };
    if status != ffi::NARSIL_OK {
        out.truncate(before);
        return Err(core_refused("a case fold", status));
    }
    out.truncate(before + count as usize);
    Ok(())
}

pub(crate) fn append_case_fold(text: &str, out: &mut Vec<u32>) -> Result<()> {
    let units: Vec<u16> = text.encode_utf16().collect();
    append_folded_units(&units, out)
}

pub(crate) fn append_folded_code_point(code_point: u32, out: &mut Vec<u32>) -> Result<()> {
    let Some(character) = char::from_u32(code_point) else {
        out.push(code_point);
        return Ok(());
    };
    let mut units = [0u16; MAX_UNITS_PER_CODE_POINT];
    append_folded_units(character.encode_utf16(&mut units), out)
}

pub(crate) fn case_fold_exceeds(text: &str, limit: usize) -> Result<bool> {
    let code_points = text.chars().count();
    if code_points > limit {
        return Ok(true);
    }
    if code_points * MAX_FOLD_CODE_POINTS <= limit {
        return Ok(false);
    }
    let mut folded = Vec::new();
    append_case_fold(text, &mut folded)?;
    Ok(folded.len() > limit)
}
