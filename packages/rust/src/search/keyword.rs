use std::cmp::Ordering;

use super::components::{ComponentSource, ScoreComponents};
use super::core_call::{Settings, score};
use super::phrase::{PhraseWork, match_phrases};
use super::plan::{field_names, field_scoring, plan_segment, request_pool};
use super::query::{KeywordQuery, PhraseRows};
use super::rankings::{RankedEntry, merge_rankings, score_then_id};
use super::request::RequestBuilder;
use super::stats::QueryStats;
use crate::error::Result;
use crate::index::partition::PartitionSnapshot;

/// One document that a keyword search scored.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct KeywordHit {
    pub(crate) id: String,
    pub(crate) score: f64,
    pub(crate) components: Option<ScoreComponents>,
}

/// The documents that a keyword search of one partition scored, best first, with the number that matched and,
/// where the query asks for it, the bitset of matched ordinals in each segment.
#[derive(Debug, Default)]
pub(crate) struct PartitionHits {
    pub(crate) hits: Vec<KeywordHit>,
    pub(crate) total_matched: u64,
    pub(crate) matched: Vec<Option<Vec<u32>>>,
}

/// What a search hands each segment beyond the query: the filter's bitset over its ordinals, and the meter that
/// counts the work of its phrase matches.
pub(crate) struct SegmentInputs<'a> {
    pub(crate) filters: Option<&'a [Vec<u32>]>,
    pub(crate) work: &'a mut dyn PhraseWork,
}

impl RankedEntry for KeywordHit {
    fn ranking_score(&self) -> f64 {
        self.score
    }

    fn ranking_id(&self) -> &str {
        &self.id
    }
}

fn hit_order(left: &KeywordHit, right: &KeywordHit) -> Ordering {
    score_then_id((left.score, &left.id), (right.score, &right.id))
}

/// Scores every segment of a partition on the native core and merges their hits.
pub(crate) fn search_partition(
    snapshot: &PartitionSnapshot,
    query: &KeywordQuery<'_>,
    stats: &QueryStats,
    inputs: SegmentInputs<'_>,
) -> Result<PartitionHits> {
    let mut result = PartitionHits {
        matched: vec![None; snapshot.segments.len()],
        ..PartitionHits::default()
    };
    if query.tokens.is_empty() && query.phrases.is_empty() {
        return Ok(result);
    }
    let mut builder = RequestBuilder::default();
    let mut pages: Vec<Vec<KeywordHit>> = Vec::with_capacity(snapshot.segments.len());
    for (at, entry) in snapshot.segments.iter().enumerate() {
        if entry.live_count() == 0 {
            continue;
        }
        let mut filter = inputs
            .filters
            .and_then(|filters| filters.get(at))
            .map(Vec::as_slice);
        let fields = field_scoring(entry, query, stats);
        let phrase_matches = match query.phrases.is_empty() {
            true => None,
            false => match match_phrases(
                entry,
                query.phrases,
                &fields.searchable,
                filter,
                inputs.work,
            )? {
                found if found.matched.iter().any(|&word| word != 0) => Some(found),
                _ => continue,
            },
        };
        if let Some(found) = &phrase_matches {
            filter = Some(&found.matched);
        }
        let phrases: &[PhraseRows] = phrase_matches.as_ref().map_or(&[], |found| &found.rows);
        plan_segment(entry, query, stats, phrases, &mut builder)?;
        let pool = request_pool(entry, &builder);
        let settings = Settings {
            terms: query.tokens.len(),
            capacity: entry.capacity(),
            total_documents: stats.total_documents,
            limit: query.max_results,
            collect: query.collect,
            filter,
            removed: entry.removed_bits(),
        };
        let scored = score(&builder, pool, &fields, &settings)?;
        let components = query.components.then(|| {
            ComponentSource {
                builder: &builder,
                pool,
                fields: &fields,
                names: field_names(entry),
                filter,
                removed: entry.removed_bits(),
                total_documents: stats.total_documents,
            }
            .components(&scored.ordinals)
        });
        let mut page: Vec<KeywordHit> = Vec::with_capacity(scored.ordinals.len());
        for (&ordinal, &score) in scored.ordinals.iter().zip(&scored.scores) {
            page.push(KeywordHit {
                id: entry.id_of(ordinal)?.into_owned(),
                score,
                components: components
                    .as_ref()
                    .map(|found| found.get(&ordinal).cloned().unwrap_or_default()),
            });
        }
        page.sort_by(hit_order);
        if let Some(limit) = query.max_results {
            page.truncate(limit);
        }
        pages.push(page);
        result.total_matched += u64::from(scored.total_matched);
        result.matched[at] = scored.matched;
    }
    result.hits = merge_rankings(pages, query.max_results)?;
    Ok(result)
}
