use super::{ExpansionSources, expansion_rows, units};
use crate::error::Result;
use crate::ffi;

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
        let rows = expansion_rows("a prefix completion", |workspace, output, count| unsafe {
            ffi::narsil_expand_prefix(workspace, &request, &output, count)
        })?;
        (0..rows.count)
            .map(|at| self.expansion(&rows, at))
            .collect()
    }
}
