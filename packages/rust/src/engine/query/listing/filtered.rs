use super::super::scope::QueryScope;
use super::seek::SegmentMatcher;
use crate::engine::index::IndexState;
use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::segment::SegmentEntry;
use crate::pattern::SearchLimits;
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
/// rule, before the listing reads a document. The pattern tests of the filter may spend the work cap of `limits`
/// across every segment, past which the listing fails with `SEARCH_WORK_CAP_EXCEEDED`, and they fail with
/// `INSTANCE_SHUT_DOWN` once the engine shuts down.
pub(crate) fn segment_matcher<'a>(
    index: &'a IndexState,
    filters: Option<&Value>,
    limits: &SearchLimits,
) -> Result<Option<Box<SegmentMatcher<'a>>>> {
    let scope = QueryScope::new(index, filters, limits)?;
    if !scope.filters() {
        return Ok(None);
    }
    Ok(Some(Box::new(move |entry: &SegmentEntry| {
        Ok(scope.segment_bits(entry)?.unwrap_or_default())
    })))
}
