use std::cmp::Ordering;

use crate::engine::query::cursor::{
    PageCursor, decode_matching_cursor, encode_page_cursor, list_binding, query_binding_of,
    sort_signature_of,
};
use crate::engine::query::facets::merge_bucket_lists;
use crate::engine::query::pinned::{Placed, deduped_pins, place_pins_within};
use crate::engine::{Pin, QueryParams, SortDirection, SortField};
use crate::error::Result;
use crate::ordering::{KeyBatch, OwnedSortValue};
use crate::search::rankings::{RankedEntry, merge_rankings};
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

struct RankedReference {
    score: f64,
    id: String,
    list: usize,
    index: usize,
}

impl RankedEntry for RankedReference {
    fn ranking_score(&self) -> f64 {
        self.score
    }

    fn ranking_id(&self) -> &str {
        &self.id
    }
}

/// Merges rankings that each already follow the score order, and returns the list and the index within it of each
/// entry of the merged ranking, at most `limit` of them. An absent score ranks as negative infinity.
///
/// # Errors
///
/// Fails with `CONFIG_INVALID` where the rankings exceed the native merge layout.
pub fn merge_scored(lists: &[Vec<(Option<f64>, &str)>], limit: usize) -> Result<Vec<(usize, usize)>> {
    let references: Vec<Vec<RankedReference>> = lists
        .iter()
        .enumerate()
        .map(|(list, entries)| {
            entries
                .iter()
                .enumerate()
                .map(|(index, (score, id))| RankedReference {
                    score: score.unwrap_or(f64::NEG_INFINITY),
                    id: (*id).to_string(),
                    list,
                    index,
                })
                .collect()
        })
        .collect();
    Ok(merge_rankings(references, Some(limit))?
        .into_iter()
        .map(|entry| (entry.list, entry.index))
        .collect())
}

/// The counts that merging the facet buckets of many nodes kept, and how far below its true count any merged count
/// can be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedFacetBuckets {
    /// The kept buckets, each value with its summed count, in the facet's order.
    pub buckets: Vec<(String, u32)>,
    /// The largest count that any value can lack.
    pub error_bound: u32,
}

/// Merges the facet buckets of one field that many nodes counted, where `bounds` holds the largest count that each
/// node left out, keeping at most `limit` buckets.
///
/// # Errors
///
/// Fails with `CONFIG_INVALID` where the counts exceed the native merge layout.
pub fn merge_facet_buckets(
    lists: &[Vec<(String, u32)>],
    bounds: &[u32],
    ascending: bool,
    limit: Option<usize>,
) -> Result<MergedFacetBuckets> {
    let merged = merge_bucket_lists(lists, bounds, ascending, limit)?;
    Ok(MergedFacetBuckets {
        buckets: merged.buckets,
        error_bound: merged.error_bound,
    })
}

/// One entry of a ranking after pin placement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinnedPlace {
    /// The entry at this place of the ranking.
    Ranked(usize),
    /// The pin at this place of the deduplicated pins.
    Pin(usize),
}

/// The ranking after pin placement, the pins that placement used once each in the order that the query lists them,
/// and the place in the ranking of each pin's document where the ranking holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedPlacement {
    /// The placed ranking.
    pub order: Vec<PinnedPlace>,
    /// Each pin that placement used, the first listing of a document alone.
    pub pins: Vec<Pin>,
    /// For each pin, the place of its document in the ranking, or `None` where the ranking lacks it.
    pub ranked: Vec<Option<usize>>,
}

/// Places `pins` into a ranking of document ids, as one engine places them, leaving out each pin at or past `depth`
/// where `depth` is set.
///
/// # Errors
///
/// Fails with `CONFIG_INVALID` where the ranking or the pins exceed the native layout.
pub fn place_pins(
    ranked_ids: &[String],
    pins: &[Pin],
    depth: Option<usize>,
) -> Result<PinnedPlacement> {
    let deduped = deduped_pins(pins);
    let (placed, _) = place_pins_within(
        ranked_ids.iter().map(String::as_str),
        ranked_ids.len(),
        &deduped,
        depth,
    )?;
    let ranked = deduped
        .iter()
        .map(|pin| ranked_ids.iter().position(|id| *id == pin.doc_id))
        .collect();
    Ok(PinnedPlacement {
        order: placed
            .into_iter()
            .map(|place| match place {
                Placed::Ranked(at) => PinnedPlace::Ranked(at),
                Placed::Pin(at) => PinnedPlace::Pin(at),
            })
            .collect(),
        pins: deduped.into_iter().cloned().collect(),
        ranked,
    })
}
