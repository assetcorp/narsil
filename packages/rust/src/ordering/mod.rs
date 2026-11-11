mod batch;
mod column;
mod constants;
mod native;
mod values;

pub(crate) use batch::KeyBatch;
pub(crate) use column::SortColumn;
pub(crate) use constants::SORT_VALUE_MAX_CODE_POINTS;
pub(crate) use native::{
    SelectRequest, TextRangeBounds, padded, push_reduced, sort_select, text_range,
};
pub(crate) use values::{OwnedSortValue, SortValues};

use crate::engine::{SortDirection, SortMode};

pub(crate) fn default_sort_mode(direction: SortDirection) -> SortMode {
    match direction {
        SortDirection::Asc => SortMode::Min,
        SortDirection::Desc => SortMode::Max,
    }
}
