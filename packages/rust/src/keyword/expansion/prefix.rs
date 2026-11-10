use super::{ExpansionSources, units};
use crate::error::Result;
use crate::ffi;
use crate::keyword::constants::{EXPANSION_START_CAPACITY, MAX_ROOM_ATTEMPTS};
use crate::keyword::workspace::{core_refused, with_workspace};

impl ExpansionSources<'_> {
    pub(crate) fn complete_prefix(&self, typed: &str, stemmed: &str) -> Result<Vec<(String, f64)>> {
        let typed = units(typed);
        let own = units(stemmed);
        let (segments, segment_count) = self.segments();
        let request = ffi::narsil_prefix_request {
            segments,
            segment_count,
            typed: typed.as_ptr(),
            typed_length: typed.len(),
            stemmed: own.as_ptr(),
            stemmed_length: own.len(),
            own: own.as_ptr(),
            own_length: own.len(),
        };
        let mut capacity = EXPANSION_START_CAPACITY;
        for _ in 0..MAX_ROOM_ATTEMPTS {
            let mut found_segments = vec![0u32; capacity];
            let mut tokens = vec![0u32; capacity];
            let mut factors = vec![0f64; capacity];
            let output = ffi::narsil_expansion_output {
                segments: found_segments.as_mut_ptr(),
                segment_capacity: capacity,
                tokens: tokens.as_mut_ptr(),
                token_capacity: capacity,
                factors: factors.as_mut_ptr(),
                factor_capacity: capacity,
            };
            let mut count = 0u32;
            let status = with_workspace(|workspace| {
                Ok(unsafe { ffi::narsil_expand_prefix(workspace, &request, &output, &mut count) })
            })?;
            match status {
                ffi::NARSIL_OK => {
                    let mut completions = Vec::with_capacity(count as usize);
                    for at in 0..count as usize {
                        let token = self.token(found_segments[at], tokens[at])?;
                        completions.push((token, factors[at]));
                    }
                    return Ok(completions);
                }
                ffi::NARSIL_NEEDS_ROOM => capacity *= 2,
                status => return Err(core_refused("a prefix completion", status)),
            }
        }
        Err(core_refused("a prefix completion", ffi::NARSIL_NEEDS_ROOM))
    }
}
