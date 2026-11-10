mod checks;
mod compile;
mod compile_values;
pub(crate) mod constants;
mod evaluate;
mod expression;
mod geo_checks;
mod list_checks;
mod operands;
mod pattern_checks;
mod segments;
pub(crate) mod source;
mod stored;
mod walk;

pub use self::expression::{FieldTests, Filter};
pub use self::operands::{DistanceUnit, GeoPolygon, GeoRadius, Scalar, Tolerance};
pub(crate) use self::source::FilterSource;

use self::compile::{CompiledExpression, compile_filter};
use self::source::{and_not_into, empty_bits};
use crate::error::Result;
use crate::index::segment::{SegmentData, SegmentEntry};
use crate::pattern::{PatternScratch, WorkMeter};
use crate::schema::CompiledSchema;
use crate::value::Value;

pub(crate) struct CompiledFilter {
    root: CompiledExpression,
}

pub(crate) fn live_bits(capacity: u32, tombstones: &[u32]) -> Vec<u32> {
    let mut live = empty_bits(capacity);
    for word in live.iter_mut() {
        *word = u32::MAX;
    }
    let spare = (live.len() as u32 * 32).saturating_sub(capacity);
    if let Some(last) = live.last_mut() {
        if spare > 0 {
            *last = u32::MAX >> spare;
        }
    }
    and_not_into(&mut live, tombstones);
    live
}

impl CompiledFilter {
    pub(crate) fn new(filter: &Value, schema: &CompiledSchema) -> Result<CompiledFilter> {
        Ok(CompiledFilter {
            root: compile_filter(filter, schema)?,
        })
    }

    pub(crate) fn evaluate<S: FilterSource>(
        &self,
        source: &S,
        live: &[u32],
        meter: &WorkMeter,
        scratch: &mut PatternScratch,
    ) -> Result<Vec<u32>> {
        evaluate::evaluate_filter(&self.root, source, live, meter, scratch)
    }

    pub(crate) fn evaluate_segment(
        &self,
        entry: &SegmentEntry,
        meter: &WorkMeter,
        scratch: &mut PatternScratch,
    ) -> Result<Vec<u32>> {
        let live = live_bits(entry.capacity(), &entry.tombstones);
        match &entry.data {
            SegmentData::Frozen(segment) => self.evaluate(segment.as_ref(), &live, meter, scratch),
            SegmentData::Tail(tail) => self.evaluate(tail.as_ref(), &live, meter, scratch),
        }
    }
}
