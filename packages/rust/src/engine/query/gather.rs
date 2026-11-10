use std::borrow::Cow;
use std::cell::OnceCell;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use super::bm25::merged_bm25;
use super::cursor::query_binding_of;
use super::documents::{Location, QuerySnapshots};
use super::facets::{MatchedSegment, count_facets};
use super::fulltext::{TextSearch, analyse_text, partition_terms, search_partition_text};
use super::params::QueryParams;
use super::scope::QueryScope;
use super::scored::needs_all_results;
use super::scoring::{GlobalStats, scoring_mode};
use super::spread;
use super::vector::RankedHits;
use crate::config::ScoringMode;
use crate::engine::index::IndexState;
use crate::error::Result;
use crate::index::partition::PartitionSnapshot;
use crate::index::segment::set_bit;
use crate::search::keyword::KeywordHit;
use crate::search::rankings::merge_rankings;
use crate::value::Map;

pub(crate) struct QueryRun<'q> {
    pub(crate) index: &'q IndexState,
    pub(crate) params: &'q QueryParams,
    pub(crate) scope: &'q QueryScope,
    pub(crate) snapshots: QuerySnapshots,
    pub(crate) limit: usize,
    pub(crate) offset: usize,
    pub(crate) signature: Option<String>,
    requested: &'q QueryParams,
    binding: OnceCell<String>,
}

pub(crate) struct RunShape<'q> {
    pub(crate) requested: &'q QueryParams,
    pub(crate) limit: usize,
    pub(crate) offset: usize,
    pub(crate) signature: Option<String>,
}

impl<'q> QueryRun<'q> {
    pub(crate) fn new(
        index: &'q IndexState,
        params: &'q QueryParams,
        scope: &'q QueryScope,
        shape: RunShape<'q>,
    ) -> Result<QueryRun<'q>> {
        Ok(QueryRun {
            index,
            params,
            scope,
            snapshots: QuerySnapshots::of(index)?,
            limit: shape.limit,
            offset: shape.offset,
            signature: shape.signature,
            requested: shape.requested,
            binding: OnceCell::new(),
        })
    }

    pub(crate) fn binding(&self) -> &str {
        self.binding
            .get_or_init(|| query_binding_of(self.requested))
    }

    pub(crate) fn locate(&self, id: &str) -> Result<Option<Location>> {
        self.snapshots.locate(self.index, id)
    }

    pub(crate) fn document(
        &self,
        id: &str,
        location: Option<Location>,
    ) -> Result<Option<Arc<Map>>> {
        self.snapshots.document(self.index, id, location)
    }
}

pub(crate) struct TextOutcome {
    pub(crate) hits: Vec<KeywordHit>,
    pub(crate) total_matched: u64,
    pub(crate) matched: Vec<Vec<Option<Vec<u32>>>>,
}

fn global_stats(
    snapshots: &[Arc<PartitionSnapshot>],
    search: &TextSearch<'_>,
) -> Result<GlobalStats> {
    let mut terms = BTreeSet::new();
    for snapshot in snapshots {
        terms.append(&mut partition_terms(snapshot, search)?);
    }
    GlobalStats::of(snapshots, terms)
}

pub(crate) fn search_text(
    run: &QueryRun<'_>,
    params: &QueryParams,
    collect: bool,
    without_hits: bool,
) -> Result<TextOutcome> {
    let mut outcome = TextOutcome {
        hits: Vec::new(),
        total_matched: 0,
        matched: Vec::new(),
    };
    let index = run.index;
    let Some(text) = analyse_text(index, &run.snapshots.layout, params)? else {
        return Ok(outcome);
    };
    let bm25 = merged_bm25(params.bm25.as_ref(), index.config().bm25.as_ref());
    let snapshots = &run.snapshots.partitions;
    let mut search = TextSearch {
        params,
        text: &text,
        bm25: &bm25,
        global: None,
        collect,
        without_hits,
    };
    let global = match scoring_mode(index, params) {
        ScoringMode::Local => None,
        _ if snapshots.len() < 2 => None,
        _ => Some(global_stats(snapshots, &search)?),
    };
    search.global = global.as_ref();
    let scope = run.scope;
    let answers = spread::each_partition(snapshots, |snapshot| {
        let mut work = scope.phrase_work();
        let filter = scope.partition_filter(snapshot)?;
        search_partition_text(snapshot, &search, filter.as_ref(), &mut work)
    });
    let mut lists = Vec::new();
    for found in answers {
        let found = found?;
        lists.push(found.hits);
        outcome.total_matched += found.total_matched;
        outcome.matched.push(found.matched);
    }
    outcome.hits = merge_rankings(lists, None)?;
    Ok(outcome)
}

pub(crate) fn collected_segments<'s>(
    snapshots: &'s QuerySnapshots,
    matched: &'s [Vec<Option<Vec<u32>>>],
) -> Vec<MatchedSegment<'s>> {
    let mut segments = Vec::new();
    for (partition_at, (snapshot, partition)) in
        snapshots.partitions.iter().zip(matched).enumerate()
    {
        for (segment_at, (entry, words)) in snapshot.segments.iter().zip(partition).enumerate() {
            if let Some(words) = words {
                segments.push(MatchedSegment {
                    partition: partition_at as u32,
                    segment: segment_at as u32,
                    entry,
                    words: Cow::Borrowed(words.as_slice()),
                });
            }
        }
    }
    segments
}

pub(crate) fn located_segments<'s>(
    snapshots: &'s QuerySnapshots,
    locations: impl Iterator<Item = Location>,
) -> Vec<MatchedSegment<'s>> {
    let mut grouped: BTreeMap<(u32, u32), Vec<u32>> = BTreeMap::new();
    for location in locations {
        set_bit(
            grouped
                .entry((location.partition, location.segment))
                .or_default(),
            location.ordinal,
        );
    }
    grouped
        .into_iter()
        .filter_map(|((partition, segment), words)| {
            let entry = snapshots
                .partitions
                .get(partition as usize)?
                .segments
                .get(segment as usize)?;
            Some(MatchedSegment {
                partition,
                segment,
                entry,
                words: Cow::Owned(words),
            })
        })
        .collect()
}

pub(crate) fn text_ranked(run: &QueryRun<'_>, params: &QueryParams) -> Result<RankedHits> {
    let collect = params.facets.is_some() && !needs_all_results(params);
    let outcome = search_text(run, params, collect, false)?;
    let mut ranked = RankedHits {
        total_matched: outcome.total_matched,
        ..RankedHits::empty()
    };
    if params.facets.is_some() {
        let facets = match collect {
            true => count_facets(
                run.index,
                params,
                &collected_segments(&run.snapshots, &outcome.matched),
            )?,
            false => {
                ranked.locations = outcome
                    .hits
                    .iter()
                    .map(|hit| run.locate(&hit.id))
                    .collect::<Result<Vec<Option<Location>>>>()?;
                let located = ranked.locations.iter().flatten().copied();
                count_facets(
                    run.index,
                    params,
                    &located_segments(&run.snapshots, located),
                )?
            }
        };
        ranked.facets = Some(facets);
    }
    ranked.hits = outcome.hits;
    Ok(ranked)
}
