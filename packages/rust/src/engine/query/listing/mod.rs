mod constants;
mod filtered;
mod projection;
mod seek;
mod sorted;

use std::sync::Arc;
use std::time::{Duration, Instant};

use super::constants::DEFAULT_PAGE_SIZE;
use super::cursor::{
    PageCursor, decode_matching_cursor, encode_page_cursor, list_binding, sort_signature_of,
};
use super::params::{DocumentProjection, SortField};
use super::projection::resolve_projection;
use super::require_within_result_window;
use super::validate::require_sortable_fields;
use crate::engine::Narsil;
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::index::partition::PartitionSnapshot;
use crate::ordering::OwnedSortValue;
use crate::pattern::SearchLimits;
use crate::value::{Map, Value};
use constants::MIN_LIST_PAGE_SIZE;
use filtered::{require_listing_filter, segment_matcher};
use projection::listed_document;
use seek::{PartitionPage, SegmentMatcher, partition_candidates};
use sorted::{ListingPage, SortedRequest, sorted_listing};

/// Everything that [`Narsil::list_documents`] accepts. Leave `cursor` out for the first page, then pass back the
/// cursor of each result until it comes back `None`.
#[derive(Debug, Clone, Default)]
pub struct ListParams {
    /// The cursor of the previous page, which continues where that page stopped.
    pub cursor: Option<String>,
    /// The number of documents on the page, 10 by default; the engine raises 0 to 1 and refuses more than 10,000.
    pub limit: Option<usize>,
    /// A filter expression that narrows the listing to the documents it accepts, in the same shape as a query's.
    pub filters: Option<Value>,
    /// Which parts of each stored document come back, the whole document by default.
    pub document: Option<DocumentProjection>,
}

/// One document of a listing page.
#[derive(Debug, Clone, PartialEq)]
pub struct ListedDocument {
    /// The ID of the document.
    pub id: String,
    /// The stored document, cut down to what the listing's projection keeps.
    pub document: Map,
}

/// One page of [`Narsil::list_documents`].
#[derive(Debug, Clone, PartialEq)]
pub struct ListResult {
    /// The documents of the page, in ascending code point order of their IDs, or in the order of the sort that
    /// [`Narsil::list_documents_sorted`] takes.
    pub documents: Vec<ListedDocument>,
    /// The cursor that reaches the next page, or `None` once the listing has reached its last document.
    pub cursor: Option<String>,
    /// The number of documents that the listing covers, which a filter narrows.
    pub total: u64,
    /// The time that the engine spent building the page.
    pub elapsed: Duration,
}

fn list_page_size(limit: Option<usize>) -> Result<usize> {
    let size = limit.unwrap_or(DEFAULT_PAGE_SIZE).max(MIN_LIST_PAGE_SIZE);
    require_within_result_window(size, 0)?;
    Ok(size)
}

fn id_order_page(
    snapshots: &[Arc<PartitionSnapshot>],
    anchor: Option<&str>,
    matcher: Option<&SegmentMatcher<'_>>,
    limit: usize,
    binding: &str,
) -> Result<ListingPage> {
    let wanted = limit + 1;
    let mut ids = Vec::new();
    let mut total = 0u64;
    for snapshot in snapshots {
        let page = partition_candidates(snapshot, anchor, matcher, wanted)?;
        total += page.total;
        ids.extend(page.ids);
    }
    ids.sort_unstable();
    ids.dedup();
    let more_follow = ids.len() > limit;
    ids.truncate(limit);
    let cursor = match ids.last() {
        Some(last) if more_follow => Some(encode_page_cursor(&PageCursor {
            anchor: last.clone(),
            score: None,
            sort_key: None,
            sort_signature: None,
            depth: 0,
            binding: binding.to_string(),
        })),
        _ => None,
    };
    Ok(ListingPage {
        page: PartitionPage { ids, total },
        cursor,
    })
}

fn listed_page(
    index: &IndexState,
    params: &ListParams,
    sort: &[SortField],
    limits: &SearchLimits,
) -> Result<ListResult> {
    let started = Instant::now();
    let limit = list_page_size(params.limit)?;
    let signature = sort_signature_of(Some(sort))?;
    require_sortable_fields(index, Some(sort))?;
    let matcher = segment_matcher(index, params.filters.as_ref(), limits)?;
    let projection = resolve_projection(params.document.as_ref());
    let binding = list_binding(params.filters.as_ref());
    let cursor = match &params.cursor {
        None => None,
        Some(text) => Some(decode_matching_cursor(
            text,
            signature.as_deref(),
            false,
            &binding,
        )?),
    };
    require_listing_filter(params.filters.as_ref())?;
    let snapshots: Vec<Arc<PartitionSnapshot>> = index
        .partitions()
        .iter()
        .map(|partition| partition.snapshot())
        .collect();
    let listing = match &signature {
        None => id_order_page(
            &snapshots,
            cursor.as_ref().map(|cursor| cursor.anchor.as_str()),
            matcher.as_deref(),
            limit,
            &binding,
        )?,
        Some(signature) => sorted_listing(
            &snapshots,
            matcher.as_deref(),
            &SortedRequest {
                sort,
                signature,
                binding: &binding,
                anchor: cursor.map(|cursor| {
                    let key = cursor.sort_key.unwrap_or_default();
                    (
                        cursor.anchor,
                        key.iter().map(OwnedSortValue::of_cursor).collect(),
                    )
                }),
                limit,
            },
        )?,
    };
    let ListingPage {
        page: PartitionPage { ids, total },
        cursor,
    } = listing;
    let mut documents = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(document) = listed_document(index, &id, &projection)? {
            documents.push(ListedDocument { id, document });
        }
    }
    Ok(ListResult {
        documents,
        cursor,
        total,
        elapsed: started.elapsed(),
    })
}

impl Narsil {
    /// Returns one page of the index's stored documents in ascending code point order of their IDs, without
    /// searching, which is how a caller pages through a whole index.
    ///
    /// A document that stays in the index for the whole listing comes back exactly once. The engine skips a
    /// document that a write removes part-way through, and returns one inserted part-way through once its ID sorts
    /// after the cursor. The cursor holds no engine state, so it stays valid after a restart, and it matches the
    /// cursor that every other Narsil engine hands out for the same page. Set `document` to drop a vector field,
    /// because the engine otherwise reads each listed document's vectors back out of the index.
    ///
    /// Fails with `SEARCH_RESULT_WINDOW_EXCEEDED` for a `limit` above 10,000, with `SEARCH_INVALID_FILTER` or
    /// `SEARCH_INVALID_FIELD` for a filter that breaks a rule, with `SEARCH_WORK_CAP_EXCEEDED` where the filter's
    /// pattern tests pass the engine's `pattern_work_cap`, with `SEARCH_INVALID_CURSOR` for a cursor that is
    /// malformed or that a listing with other filters produced, with `INDEX_NOT_FOUND` where the engine holds no
    /// index called `index`, and with `INSTANCE_SHUT_DOWN` once the engine shuts down, even part-way through the
    /// filter's pattern tests.
    pub fn list_documents(&self, index: &str, params: &ListParams) -> Result<ListResult> {
        self.inner.read_index(index, |current| {
            listed_page(current, params, &[], &self.inner.search_limits)
        })
    }

    /// Returns one page of the index's stored documents in the order of `sort`, without searching, breaking each
    /// tie on document ID in ascending code point order. An empty `sort` lists in ID order, as
    /// [`Narsil::list_documents`] does.
    ///
    /// The engine reads the sort value of every document that the listing covers to build each page, so a sorted
    /// listing costs more than the ID order on a large index. The cursor carries the sort key and the sort of the
    /// page, and it matches the cursor that every other Narsil engine hands out for the same page.
    ///
    /// Fails as [`Narsil::list_documents`] does, and with `SEARCH_INVALID_FIELD` for a sort of more than 8 fields,
    /// for a field name longer than the cursor allows, and for a field that the engine cannot sort by, which is a
    /// text field whose type leaves out `sortable`, a geopoint, or a vector. Fails with `SEARCH_INVALID_CURSOR` for a
    /// cursor that a listing with another sort produced.
    pub fn list_documents_sorted(
        &self,
        index: &str,
        params: &ListParams,
        sort: &[SortField],
    ) -> Result<ListResult> {
        self.inner.read_index(index, |current| {
            listed_page(current, params, sort, &self.inner.search_limits)
        })
    }
}
