mod checks;
pub(crate) mod constants;
mod expression;
mod geo_checks;
mod list_checks;
mod operands;
mod pattern_checks;
mod plan;
mod plan_values;
mod program;
mod regions;
mod segments;
pub(crate) mod source;
mod tree;
mod walk;

pub use self::expression::{FieldTests, Filter};
pub use self::operands::{DistanceUnit, GeoPolygon, GeoRadius, Scalar, Tolerance};

use self::plan::expression_plan;
use self::program::FilterProgram;
use self::source::{and_not_into, empty_bits};
use self::tree::{FilterNode, filter_tree};
use self::walk::validated_filter_of;
use crate::error::Result;
use crate::index::segment::SegmentEntry;
use crate::pattern::WorkMeter;
use crate::schema::CompiledSchema;
use crate::value::Value;

pub(crate) struct CompiledFilter {
    root: FilterNode,
}

fn live_bits(capacity: u32, tombstones: &[u32]) -> Vec<u32> {
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
        let validated = validated_filter_of(filter, schema)?;
        Ok(CompiledFilter {
            root: filter_tree(&validated, schema),
        })
    }

    pub(crate) fn evaluate_segment(
        &self,
        entry: &SegmentEntry,
        meter: &WorkMeter,
    ) -> Result<Vec<u32>> {
        let capacity = entry.capacity();
        if capacity == 0 {
            return Ok(Vec::new());
        }
        let mut program =
            FilterProgram::new(entry, live_bits(capacity, entry.removed_bits()), meter);
        expression_plan(&self.root, &mut program)?;
        program.evaluate()
    }
}
