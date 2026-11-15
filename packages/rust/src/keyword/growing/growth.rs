use super::{GrowingSegment, MAX_FIELDS, words_for};
use crate::keyword::slices::{MAX_POOL_ENTRIES, grown_capacity};

const TERM_COLUMN_BYTES: usize = 5 * size_of::<u32>() + 2 * size_of::<f64>() + 2 * size_of::<u8>();
const POSITIONS_PER_TERM: usize = 2;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct KeywordAdditions {
    pub(crate) ordinals: usize,
    pub(crate) fields: usize,
    pub(crate) terms: usize,
    pub(crate) units: usize,
}

impl GrowingSegment {
    pub(crate) fn growth_bytes(&self, added: &KeywordAdditions) -> usize {
        let mut bytes = self.terms.growth_bytes(added.terms, added.units);
        let capacity = self.terms.capacity_after(added.terms);
        if capacity > self.columns.flags.len() {
            bytes = bytes.saturating_add(capacity.saturating_mul(TERM_COLUMN_BYTES));
        }
        bytes = bytes.saturating_add(self.postings.growth_bytes(added.terms));
        if let Some(positions) = &self.positions {
            bytes = bytes.saturating_add(
                positions.growth_bytes(added.terms.saturating_mul(POSITIONS_PER_TERM)),
            );
        }
        if let Some(surfaces) = &self.surfaces {
            bytes = bytes.saturating_add(surfaces.growth_bytes(added.terms, added.units));
        }
        if let Some(spellings) = &self.spellings {
            bytes =
                bytes.saturating_add(spellings.growth_bytes(added.terms, added.units, added.units));
        }
        bytes.saturating_add(self.ordinal_growth_bytes(added))
    }

    fn ordinal_growth_bytes(&self, added: &KeywordAdditions) -> usize {
        let fields = added.fields.max(self.partial_fields.len()).min(MAX_FIELDS);
        let capacity = match added.ordinals > self.ordinal_capacity {
            true => grown_capacity(self.ordinal_capacity, added.ordinals, MAX_POOL_ENTRIES)
                .unwrap_or(MAX_POOL_ENTRIES),
            false => self.ordinal_capacity,
        };
        if capacity == self.ordinal_capacity && fields == self.partial_fields.len() {
            return 0;
        }
        let retired = match words_for(capacity) > self.retired.len() {
            true => words_for(capacity).saturating_mul(size_of::<u32>()),
            false => 0,
        };
        capacity
            .saturating_mul(fields)
            .saturating_mul(size_of::<u32>())
            .saturating_add(fields.saturating_mul(size_of::<f64>() + size_of::<u8>()))
            .saturating_add(retired)
    }
}
