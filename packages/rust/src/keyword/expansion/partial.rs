use super::{ExpansionSources, expansion_rows, units};
use crate::error::Result;
use crate::ffi;

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
        let rows = expansion_rows("a partial-word search", |workspace, additions, count| {
            let output = ffi::narsil_partial_output {
                additions,
                starts: starts.as_mut_ptr(),
                start_capacity: starts.len(),
            };
            unsafe { ffi::narsil_expand_partial_words(workspace, &request, &output, count) }
        })?;
        starts
            .windows(2)
            .map(|pair| {
                let to = (pair[1] as usize).min(rows.count);
                (pair[0] as usize..to)
                    .map(|at| self.expansion(&rows, at))
                    .collect()
            })
            .collect()
    }
}
