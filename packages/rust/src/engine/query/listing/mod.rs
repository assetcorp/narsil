mod constants;
mod filtered;
mod projection;
mod seek;

use std::time::{Duration, Instant};

use super::constants::DEFAULT_PAGE_SIZE;
use super::cursor::{
    PageCursor, decode_page_cursor, encode_page_cursor, list_binding, require_matching_cursor,
};
use super::params::DocumentProjection;
use super::require_within_result_window;
use crate::engine::Narsil;
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::value::{Map, Value};
use constants::MIN_LIST_PAGE_SIZE;
use filtered::{require_listing_filter, segment_matcher};
use projection::{Projection, listed_document};
use seek::partition_candidates;

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
    /// The documents of the page, in ascending code point order of their IDs.
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

fn listed_page(index: &IndexState, params: &ListParams, work_cap: i64) -> Result<ListResult> {
    let started = Instant::now();
    let limit = list_page_size(params.limit)?;
    let matcher = segment_matcher(index, params.filters.as_ref(), work_cap)?;
    let projection = Projection::of(params.document.as_ref());
    let binding = list_binding(params.filters.as_ref());
    let anchor = match &params.cursor {
        None => None,
        Some(text) => {
            let cursor = decode_page_cursor(text)?;
            require_matching_cursor(&cursor, None, false, &binding)?;
            Some(cursor.anchor)
        }
    };
    require_listing_filter(params.filters.as_ref())?;
    let partitions = index.partitions();
    let wanted = limit + 1;
    let mut ids = Vec::new();
    let mut total = 0u64;
    for partition in partitions.iter() {
        let snapshot = partition.snapshot();
        let page = partition_candidates(&snapshot, anchor.as_deref(), matcher.as_deref(), wanted)?;
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
            binding,
        })),
        _ => None,
    };
    let mut documents = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(document) = listed_document(index, &partitions, &id, &projection)? {
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
    /// malformed or that a listing with other filters produced, and with `INDEX_NOT_FOUND` where the engine holds
    /// no index called `index`.
    pub fn list_documents(&self, index: &str, params: &ListParams) -> Result<ListResult> {
        listed_page(
            &*self.inner.open_index(index)?,
            params,
            self.inner.pattern_work_cap,
        )
    }
}
