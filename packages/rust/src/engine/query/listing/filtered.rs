use super::super::scope::QueryScope;
use super::seek::SegmentMatcher;
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::segment::SegmentEntry;
use crate::value::Value;

/// Fails with `SEARCH_INVALID_FILTER` for a listing whose filter is JSON `null`, which a listing checks once the
/// cursor has passed its checks, while a query treats a `null` filter as no filter.
pub(crate) fn require_listing_filter(filters: Option<&Value>) -> Result<()> {
    match filters {
        Some(Value::Null) => Err(NarsilError::new(
            ErrorCode::SEARCH_INVALID_FILTER,
            "Each filter expression must be an object",
        )),
        _ => Ok(()),
    }
}

/// Returns the matcher that gives each segment's bitset of the live documents that `filters` accepts, or `None`
/// for a listing without a filter.
///
/// Fails with `SEARCH_INVALID_FILTER`, `SEARCH_INVALID_FIELD`, or another filter code for a filter that breaks a
/// rule, before the listing reads a document. The pattern tests of the filter may spend `work_cap` units across
/// every segment, past which the listing fails with `SEARCH_WORK_CAP_EXCEEDED`.
pub(crate) fn segment_matcher<'a>(
    index: &'a IndexState,
    filters: Option<&Value>,
    work_cap: i64,
) -> Result<Option<Box<SegmentMatcher<'a>>>> {
    let scope = QueryScope::new(index, filters, work_cap)?;
    if !scope.filters() {
        return Ok(None);
    }
    Ok(Some(Box::new(move |entry: &SegmentEntry| {
        Ok(scope.segment_bits(entry)?.unwrap_or_default())
    })))
}
