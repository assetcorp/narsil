use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;

const BITSET_WORD_BITS: usize = 32;

pub(crate) struct AnchorBits {
    words: Vec<u32>,
}

impl AnchorBits {
    pub(crate) fn new(count: usize) -> AnchorBits {
        AnchorBits {
            words: vec![0; count.div_ceil(BITSET_WORD_BITS).max(1)],
        }
    }

    pub(crate) fn mark(&mut self, position: usize) {
        self.words[position / BITSET_WORD_BITS] |= 1 << (position % BITSET_WORD_BITS);
    }
}

fn unselectable(status: ffi::narsil_status) -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        format!("The result page cannot be selected, as the native core returned status {status}"),
    )
}

pub(crate) fn page_start(
    count: usize,
    scores: Option<&[f64]>,
    after_anchor: &AnchorBits,
    anchor_score: Option<f64>,
) -> Result<usize> {
    let Ok(native_count) = u32::try_from(count) else {
        return Err(unselectable(ffi::NARSIL_INVALID_ARGUMENT));
    };
    let request = ffi::narsil_page_request {
        count: native_count,
        sorted: u32::from(scores.is_none()),
        has_scores: u32::from(scores.is_some()),
        has_anchor_score: u32::from(anchor_score.is_some()),
        scores: scores.map_or(std::ptr::null(), <[f64]>::as_ptr),
        scores_length: scores.map_or(0, <[f64]>::len),
        score_present: std::ptr::null(),
        score_present_length: 0,
        after_anchor: after_anchor.words.as_ptr(),
        after_anchor_length: after_anchor.words.len(),
        anchor_score: anchor_score.unwrap_or(0.0),
    };
    let mut start = 0u32;
    let status = unsafe { ffi::narsil_page_start(&request, &mut start) };
    if status != ffi::NARSIL_OK {
        return Err(unselectable(status));
    }
    Ok(start as usize)
}
