use crate::error::Result;
use crate::pattern::WorkMeter;
use crate::search::phrase::PhraseWork;

/// The phrase work of one query, which counts against the same meter as the query's pattern tests, so that the
/// query fails with `SEARCH_WORK_CAP_EXCEEDED` once the two together pass the engine's cap.
pub(crate) struct MeteredWork<'meter> {
    meter: &'meter WorkMeter,
}

impl<'meter> MeteredWork<'meter> {
    pub(crate) fn new(meter: &'meter WorkMeter) -> MeteredWork<'meter> {
        MeteredWork { meter }
    }
}

impl PhraseWork for MeteredWork<'_> {
    fn add(&mut self, units: u64) -> Result<()> {
        self.meter.add(units.min(i64::MAX as u64) as i64)
    }
}
