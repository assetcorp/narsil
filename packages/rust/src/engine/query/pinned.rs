use std::collections::HashMap;

use super::params::Pin;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::keyword::workspace::{core_refused, with_workspace};

const MAX_PLACED_ENTRIES: usize = i32::MAX as usize;

/// One entry of a list after pin placement: a place in the ranked list, or the index of a pin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Placed {
    Ranked(usize),
    Pin(usize),
}

pub(crate) fn deduped_pins(pins: &[Pin]) -> Vec<&Pin> {
    let mut deduped: Vec<&Pin> = Vec::with_capacity(pins.len());
    for pin in pins {
        if !deduped.iter().any(|held| held.doc_id == pin.doc_id) {
            deduped.push(pin);
        }
    }
    deduped
}

fn too_many() -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        format!("A query can place pins into at most {MAX_PLACED_ENTRIES} results"),
    )
}

/// Places `pins` into a ranked list of document IDs on the native core, returning the order of the placed list
/// and, for each pin, whether the ranked list held its document.
pub(crate) fn place_pins<'a>(
    ranked_ids: impl Iterator<Item = &'a str>,
    count: usize,
    pins: &[&Pin],
) -> Result<(Vec<Placed>, Vec<bool>)> {
    if count > MAX_PLACED_ENTRIES || pins.len() > MAX_PLACED_ENTRIES {
        return Err(too_many());
    }
    let pin_of: HashMap<&str, usize> = pins
        .iter()
        .enumerate()
        .map(|(at, pin)| (pin.doc_id.as_str(), at))
        .collect();
    let mut ranked = vec![-1i32; pins.len()];
    for (place, id) in ranked_ids.enumerate() {
        if let Some(&pin) = pin_of.get(id)
            && ranked[pin] < 0
        {
            ranked[pin] = place as i32;
        }
    }
    let positions: Vec<u32> = pins
        .iter()
        .map(|pin| u32::try_from(pin.position).unwrap_or(u32::MAX))
        .collect();
    let capacity = count + pins.len();
    let mut entries = vec![0i32; capacity];
    let request = ffi::narsil_pinned_request {
        count: count as u32,
        ranked: ranked.as_ptr(),
        ranked_count: ranked.len(),
        positions: positions.as_ptr(),
        position_count: positions.len(),
        has_depth: 0,
        depth: 0,
    };
    let mut output = ffi::narsil_pinned_output {
        entries: entries.as_mut_ptr(),
        capacity,
        count: 0,
    };
    let status = with_workspace(|workspace| {
        Ok(unsafe { ffi::narsil_place_pinned(workspace, &request, &mut output) })
    })?;
    if status != ffi::NARSIL_OK {
        return Err(core_refused("a pin placement", status));
    }
    entries.truncate(output.count as usize);
    let placed = entries
        .into_iter()
        .map(|entry| match usize::try_from(entry) {
            Ok(place) => Placed::Ranked(place),
            Err(_) => Placed::Pin((-1 - i64::from(entry)) as usize),
        })
        .collect();
    Ok((placed, ranked.iter().map(|&place| place >= 0).collect()))
}
