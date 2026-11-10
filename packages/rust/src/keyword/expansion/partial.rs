use super::{ExpansionSources, units};
use crate::error::Result;
use crate::ffi;
use crate::keyword::constants::{EXPANSION_START_CAPACITY, MAX_ROOM_ATTEMPTS};
use crate::keyword::workspace::{core_refused, with_workspace};

pub(crate) struct PartialWordRequest {
    pub(crate) token: String,
    pub(crate) written: String,
    pub(crate) tolerance: u32,
    pub(crate) prefix_length: u32,
}

impl ExpansionSources<'_> {
    pub(crate) fn partial_additions(
        &self,
        requests: &[PartialWordRequest],
    ) -> Result<Vec<Vec<(String, f64)>>> {
        let texts: Vec<(Vec<u16>, Vec<u16>)> = requests
            .iter()
            .map(|request| (units(&request.written), units(&request.token)))
            .collect();
        let words: Vec<ffi::narsil_partial_word> = requests
            .iter()
            .zip(&texts)
            .map(|(request, (written, own))| ffi::narsil_partial_word {
                written: written.as_ptr(),
                written_length: written.len(),
                own: own.as_ptr(),
                own_length: own.len(),
                tolerance: request.tolerance,
                prefix_length: request.prefix_length,
            })
            .collect();
        let (segments, segment_count) = self.segments();
        let request = ffi::narsil_partial_request {
            segments,
            runs: self.runs(),
            segment_count,
            words: words.as_ptr(),
            word_count: words.len(),
        };
        let mut starts = vec![0u32; requests.len() + 1];
        let mut capacity = EXPANSION_START_CAPACITY;
        for _ in 0..MAX_ROOM_ATTEMPTS {
            let mut found_segments = vec![0u32; capacity];
            let mut tokens = vec![0u32; capacity];
            let mut factors = vec![0f64; capacity];
            let output = ffi::narsil_partial_output {
                additions: ffi::narsil_expansion_output {
                    segments: found_segments.as_mut_ptr(),
                    segment_capacity: capacity,
                    tokens: tokens.as_mut_ptr(),
                    token_capacity: capacity,
                    factors: factors.as_mut_ptr(),
                    factor_capacity: capacity,
                },
                starts: starts.as_mut_ptr(),
                start_capacity: starts.len(),
            };
            let mut count = 0u32;
            let status = with_workspace(|workspace| {
                Ok(unsafe {
                    ffi::narsil_expand_partial_words(workspace, &request, &output, &mut count)
                })
            })?;
            match status {
                ffi::NARSIL_OK => {
                    let mut additions = Vec::with_capacity(requests.len());
                    for word in 0..requests.len() {
                        let from = starts[word] as usize;
                        let to = (starts[word + 1] as usize).min(count as usize);
                        let mut added = Vec::with_capacity(to.saturating_sub(from));
                        for at in from..to {
                            added.push((self.token(found_segments[at], tokens[at])?, factors[at]));
                        }
                        additions.push(added);
                    }
                    return Ok(additions);
                }
                ffi::NARSIL_NEEDS_ROOM => capacity *= 2,
                status => return Err(core_refused("a partial-word search", status)),
            }
        }
        Err(core_refused(
            "a partial-word search",
            ffi::NARSIL_NEEDS_ROOM,
        ))
    }
}
