use std::cmp::Ordering;

use crate::engine::query::cursor::{
    PageCursor, decode_matching_cursor, encode_page_cursor, list_binding, query_binding_of,
    sort_signature_of,
};
use crate::engine::{QueryParams, SortDirection, SortField};
use crate::error::Result;
use crate::ordering::{KeyBatch, OwnedSortValue};
use crate::value::Value;

/// The paging cursor of a search or a listing, in the form that every Narsil engine encodes, so that a cluster
/// coordinator that merges the pages of many nodes hands out the cursor that one engine hands out for the same page.
#[derive(Debug, Clone, PartialEq)]
pub struct CoordinatedCursor {
    /// The id of the last document of the page.
    pub anchor: String,
    /// The score of that document, where the page is ranked by score.
    pub score: Option<f64>,
    /// The sort values of that document, where the page is sorted.
    pub sort_key: Option<Vec<Value>>,
    /// The sort that produced the page, as [`sort_signature`] gives it.
    pub sort_signature: Option<String>,
    /// The number of results before the next page.
    pub depth: u64,
    /// The binding of the request that produced the page.
    pub binding: String,
}

impl From<PageCursor> for CoordinatedCursor {
    fn from(cursor: PageCursor) -> CoordinatedCursor {
        CoordinatedCursor {
            anchor: cursor.anchor,
            score: cursor.score,
            sort_key: cursor.sort_key,
            sort_signature: cursor.sort_signature,
            depth: cursor.depth,
            binding: cursor.binding,
        }
    }
}

/// Returns the base64 text of `cursor`, byte for byte as every Narsil engine writes it.
pub fn encode_cursor(cursor: CoordinatedCursor) -> String {
    encode_page_cursor(&PageCursor {
        anchor: cursor.anchor,
        score: cursor.score,
        sort_key: cursor.sort_key,
        sort_signature: cursor.sort_signature,
        depth: cursor.depth,
        binding: cursor.binding,
    })
}

/// Decodes `cursor` and checks that a request with `signature`, `score_anchored`, and `binding` produced it.
///
/// # Errors
///
/// Fails with `SEARCH_INVALID_CURSOR`, carrying the cursor text in its details, where the cursor is malformed or
/// belongs to another request.
pub fn decode_cursor(
    cursor: &str,
    signature: Option<&str>,
    score_anchored: bool,
    binding: &str,
) -> Result<CoordinatedCursor> {
    decode_matching_cursor(cursor, signature, score_anchored, binding).map(CoordinatedCursor::from)
}

/// Returns the signature that a cursor carries for `sort`, or `None` for an absent or empty sort.
///
/// # Errors
///
/// Fails with `SEARCH_INVALID_FIELD` for a sort of more than 8 fields or a field name longer than a cursor carries.
pub fn sort_signature(sort: Option<&[SortField]>) -> Result<Option<String>> {
    sort_signature_of(sort)
}

/// Returns the cursor binding of a listing whose filter is `filters`.
pub fn listing_binding(filters: Option<&Value>) -> String {
    list_binding(filters)
}

/// Returns the cursor binding of a search with `params`.
pub fn query_binding(params: &QueryParams) -> String {
    query_binding_of(params)
}

/// Returns the sort value that a merge compares for `value`: a finite number, a boolean, or a string cut to its
/// first 512 code points, and `Value::Null` for anything else.
pub fn comparable_sort_value(value: &Value) -> Value {
    OwnedSortValue::of_cursor(value).cursor_value()
}

/// The order of many sort keys under the sort value order that every Narsil engine shares, which a coordinator
/// uses to merge the sorted pages of many nodes.
pub struct SortKeyOrder {
    ranks: crate::ordering::RankedKeys,
}

impl SortKeyOrder {
    /// Ranks every key of `keys`, where key `i` holds one sort value for each sort field.
    ///
    /// # Errors
    ///
    /// Fails with `CONFIG_INVALID` where the sort strings exceed the native value layout.
    pub fn new(keys: &[Vec<Value>]) -> Result<SortKeyOrder> {
        let width = keys.iter().map(Vec::len).max().unwrap_or(0);
        let mut batch = KeyBatch::new(width);
        for key in keys {
            let owned: Vec<OwnedSortValue> = key.iter().map(OwnedSortValue::of_cursor).collect();
            batch.push_key(&owned)?;
        }
        Ok(SortKeyOrder {
            ranks: batch.ranked()?,
        })
    }

    /// Compares key `left` with key `right`, field by field in `directions`, placing a missing value last.
    pub fn compare(&self, left: usize, right: usize, directions: &[SortDirection]) -> Ordering {
        self.ranks.compare(left, right, directions)
    }
}
