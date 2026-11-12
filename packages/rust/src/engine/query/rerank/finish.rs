use std::collections::HashSet;
use std::sync::Arc;

use super::call::score_documents;
use super::order::{Reordered, placed_hits, reorder_by_rerank};
use super::plan::RerankPlan;
use crate::engine::index::IndexState;
use crate::engine::query::documents::QuerySnapshots;
use crate::engine::query::embedded::EmbeddedQuery;
use crate::engine::query::highlight::highlight_hits;
use crate::engine::query::pagination::{PositionWindow, page_by_position};
use crate::engine::query::params::{Pin, QueryParams};
use crate::engine::query::projection::{Projection, project_document};
use crate::engine::query::results::{GroupResult, Hit, QueryResult};
use crate::error::Result;

/// What a reranked query keeps from its first stage to build its page once the rerank adapter has ordered its best
/// hits: the pins it places, the page it cuts, and the counts, facets, and groups that the first stage gave.
pub(super) struct StagedPage {
    pub(super) pins: Option<Vec<Pin>>,
    pub(super) binding: String,
    pub(super) start: usize,
    pub(super) limit: usize,
    pub(super) projection: Projection,
    pub(super) summary: QueryResult,
}

/// A reranked query whose first stage ranked its hits while a read held the index, and which waits for the rerank
/// adapter to score the best of them. The engine asks the adapter for those scores while it holds no index, so an
/// adapter can search or restore the index that the query reads.
pub(crate) struct AwaitingScores<'a> {
    pub(super) ranked_on: Arc<IndexState>,
    pub(super) embedded: EmbeddedQuery<'a>,
    pub(super) plan: RerankPlan,
    pub(super) ranked: Vec<Hit>,
    pub(super) texts: Vec<String>,
    pub(super) page: StagedPage,
}

impl<'a> AwaitingScores<'a> {
    /// Returns the scores that the rerank adapter gives the texts of the best hits, in the order of those hits.
    pub(crate) fn score(&mut self) -> Result<Vec<f64>> {
        let texts = std::mem::take(&mut self.texts);
        score_documents(
            self.ranked_on.vectors.adapters(),
            &self.plan.adapter,
            &self.plan.query,
            texts,
        )
    }

    /// Reports whether `index`, which a read holds now, is the index that the first stage ranked the hits of.
    pub(crate) fn ranked_on(&self, index: &IndexState) -> bool {
        std::ptr::eq(index, Arc::as_ptr(&self.ranked_on))
    }

    /// Returns the page of the query with its best hits in the order of `scores`, filled from `index`, the index
    /// that [`AwaitingScores::ranked_on`] reports the first stage ranked them on, which a read holds now.
    pub(crate) fn finish(
        self: Box<Self>,
        index: &IndexState,
        scores: Vec<f64>,
    ) -> Result<QueryResult> {
        let awaiting = *self;
        let window_size = scores.len();
        let ordered = reorder_by_rerank(awaiting.ranked, window_size, &scores);
        finish_page(index, &awaiting.embedded.params, awaiting.page, ordered)
    }

    /// Returns the embedded query that the first stage ran, so that a query that runs again on an index that a
    /// restore put under the name embeds its text again only where that index has another embedding adapter.
    pub(crate) fn into_embedded(self: Box<Self>) -> EmbeddedQuery<'a> {
        self.embedded
    }
}

fn with_documents(index: &IndexState, hits: Vec<Hit>, projection: &Projection) -> Result<Vec<Hit>> {
    let mut filled = Vec::with_capacity(hits.len());
    for mut hit in hits {
        hit.document = match projection {
            Projection::Nothing => Default::default(),
            _ => match index.full_document(&hit.id)? {
                Some(document) => project_document(&document, projection),
                None => continue,
            },
        };
        filled.push(hit);
    }
    Ok(filled)
}

/// Returns the page that `params` asks for from `ordered`, with the pins of `page` placed, each hit's document filled
/// from `index`, and the highlights drawn, while a read holds `index`.
pub(super) fn finish_page(
    index: &IndexState,
    params: &QueryParams,
    page: StagedPage,
    ordered: Reordered,
) -> Result<QueryResult> {
    let StagedPage {
        pins,
        binding,
        start,
        limit,
        projection,
        summary,
    } = page;
    let placed = placed_hits(&ordered.hits, pins.as_deref())?;
    let pinned_ids: Option<HashSet<&str>> = pins
        .as_ref()
        .map(|pins| pins.iter().map(|pin| pin.doc_id.as_str()).collect());
    let organic: Vec<&str> = ordered.hits.iter().map(|hit| hit.id.as_str()).collect();
    let cut = page_by_position(
        &placed,
        &organic,
        &PositionWindow {
            start,
            limit,
            pinned_ids: pinned_ids.as_ref(),
            binding: &binding,
        },
    );
    let mut hits = with_documents(index, placed[cut.range].to_vec(), &projection)?;
    let mut groups = summary.groups;
    for group in groups.iter_mut().flatten() {
        let held = std::mem::take(&mut group.hits);
        group.hits = with_documents(index, held, &projection)?;
    }
    let snapshots = QuerySnapshots::of(index)?;
    highlight_hits(
        index,
        &snapshots.layout,
        &snapshots.partitions,
        params,
        &mut hits,
        &projection,
    )?;
    share_highlights(&mut groups, &hits, &ordered.shared_ids, pinned_ids.as_ref());
    Ok(QueryResult {
        hits,
        cursor: cut.cursor,
        groups,
        ..summary
    })
}

fn share_highlights(
    groups: &mut Option<Vec<GroupResult>>,
    page: &[Hit],
    shared_ids: &HashSet<String>,
    pinned_ids: Option<&HashSet<&str>>,
) {
    for group in groups.iter_mut().flatten() {
        for hit in group.hits.iter_mut() {
            let shared = shared_ids.contains(&hit.id)
                && pinned_ids.is_none_or(|ids| !ids.contains(hit.id.as_str()));
            if !shared {
                continue;
            }
            if let Some(found) = page.iter().find(|held| held.id == hit.id) {
                hit.highlights = found.highlights.clone();
            }
        }
    }
}
