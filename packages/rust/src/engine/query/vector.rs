use std::borrow::Cow;
use std::sync::Arc;

use super::constants::RESULT_WINDOW;
use super::documents::{Location, QuerySnapshots};
use super::gather::QueryRun;
use super::params::{QueryParams, SearchMode, VectorQuery};
use super::results::FacetResult;
use super::scope::QueryScope;
use crate::adapters::EmbeddingPurpose;
use crate::config::Metric;
use crate::engine::index::IndexState;
use crate::engine::vectors::embedding::{call_adapter, require_usable_embedding};
use crate::error::{ErrorCode, NarsilError, Result};
use crate::index::partition::PartitionSnapshot;
use crate::search::components::ScoreComponents;
use crate::search::keyword::KeywordHit;
use crate::util::text::javascript_trim;
use crate::vector::search::VectorSearchOptions;

/// The hits that a query ranked, best first, with the number of documents that matched and whether that number is
/// exact.
pub(crate) struct RankedHits {
    pub(crate) hits: Vec<KeywordHit>,
    pub(crate) total_matched: u64,
    pub(crate) exact: bool,
    pub(crate) facets: Option<Vec<(String, FacetResult)>>,
    pub(crate) locations: Vec<Option<Location>>,
    pub(crate) position_depth: Option<usize>,
}

impl RankedHits {
    pub(crate) fn empty() -> RankedHits {
        RankedHits {
            hits: Vec::new(),
            total_matched: 0,
            exact: true,
            facets: None,
            locations: Vec::new(),
            position_depth: None,
        }
    }
}

/// Which search a query runs, read from its mode, its term, and its vector as every Narsil engine reads them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SearchPlan {
    Text,
    Vector,
    Hybrid,
}

/// Returns true where a query gives a term that holds more than white space.
pub(crate) fn has_term(params: &QueryParams) -> bool {
    params
        .term
        .as_deref()
        .is_some_and(|term| !javascript_trim(term).is_empty())
}

fn mode_name(mode: Option<SearchMode>) -> &'static str {
    match mode {
        Some(SearchMode::Fulltext) => "fulltext",
        Some(SearchMode::Vector) => "vector",
        Some(SearchMode::Hybrid) => "hybrid",
        None => "undefined",
    }
}

/// Returns the search that a query runs, and raises `SEARCH_INVALID_MODE` for a hybrid query that carries a sort.
pub(crate) fn plan_search(params: &QueryParams) -> Result<SearchPlan> {
    let term = has_term(params);
    let vector = params
        .vector
        .as_ref()
        .is_some_and(|clause| clause.value.is_some());
    let hybrid = params.mode == Some(SearchMode::Hybrid) || (term && vector);
    let vector_only = (params.mode == Some(SearchMode::Vector) || (vector && !term)) && !hybrid;
    let sorted = params.sort.as_ref().is_some_and(|sort| !sort.is_empty());
    if sorted && (hybrid || params.hybrid.is_some()) {
        return Err(NarsilError::new(
            ErrorCode::SEARCH_INVALID_MODE,
            "A hybrid query cannot carry a sort, because fusion defines the order of hybrid results",
        ));
    }
    Ok(match (vector_only, hybrid) {
        (true, _) => SearchPlan::Vector,
        (_, true) => SearchPlan::Hybrid,
        _ => SearchPlan::Text,
    })
}

/// Raises `SEARCH_INVALID_MODE` for a vector or hybrid query without a vector clause, and `SEARCH_INVALID_FIELD`
/// for one whose field holds no vector index.
pub(crate) fn require_vector_searchable(
    index: &IndexState,
    params: &QueryParams,
    plan: SearchPlan,
) -> Result<()> {
    if plan == SearchPlan::Text {
        return Ok(());
    }
    let Some(clause) = &params.vector else {
        return Err(NarsilError::new(
            ErrorCode::SEARCH_INVALID_MODE,
            format!(
                "A \"{}\" query needs a vector clause naming the field to search",
                mode_name(params.mode)
            ),
        ));
    };
    if index.vectors.field(&clause.field).is_some() {
        return Ok(());
    }
    Err(NarsilError::new(
        ErrorCode::SEARCH_INVALID_FIELD,
        format!(
            "Field \"{}\" has no vector index, so a vector search cannot use it",
            clause.field
        ),
    ))
}

fn query_adapter_missing(index: &IndexState) -> NarsilError {
    let message = match index
        .vectors
        .embedding()
        .and_then(|binding| binding.adapter_name())
    {
        Some(name) => format!(
            "Vector query with 'text' needs embedding adapter \"{name}\", which is not registered on this engine. Register it with registerEmbeddingAdapter or supply a raw vector."
        ),
        None => {
            "Vector query with 'text' requires an embedding adapter on the index or instance".into()
        }
    };
    NarsilError::new(ErrorCode::EMBEDDING_CONFIG_INVALID, message)
}

/// Turns a vector clause's `text` into its `value` through the index's embedding adapter, and returns the query
/// unchanged where it gives no text.
pub(crate) fn resolve_vector_text<'a>(
    index: &IndexState,
    params: &'a QueryParams,
) -> Result<Cow<'a, QueryParams>> {
    let Some(clause) = &params.vector else {
        return Ok(Cow::Borrowed(params));
    };
    let Some(text) = &clause.text else {
        return Ok(Cow::Borrowed(params));
    };
    if clause.value.is_some() {
        return Err(NarsilError::new(
            ErrorCode::EMBEDDING_CONFIG_INVALID,
            "Vector query cannot have both 'text' and 'value'",
        ));
    }
    let Some(adapter) = index.vectors.embedding_adapter() else {
        return Err(query_adapter_missing(index));
    };
    if text.is_empty() {
        return Err(NarsilError::new(
            ErrorCode::DOC_VALIDATION_FAILED,
            "Vector query 'text' must not be empty",
        ));
    }
    let vector =
        call_adapter(|| adapter.embed(text, EmbeddingPurpose::Query)).map_err(|failure| {
            failure.into_error(|message| {
                format!("The embedding adapter cannot embed the query: {message}")
            })
        })?;
    require_usable_embedding(&vector, adapter.dimensions(), "query")?;
    let mut resolved = params.clone();
    resolved.vector = Some(VectorQuery {
        value: Some(vector),
        text: None,
        ..clause.clone()
    });
    Ok(Cow::Owned(resolved))
}

/// Returns how many vectors a page of a vector search fetches: one past the page, so that the engine knows whether
/// another page follows.
pub(crate) fn vector_fetch_depth(
    limit: usize,
    offset: usize,
    cursor_depth: usize,
) -> Result<usize> {
    let reach = cursor_depth.saturating_add(offset).saturating_add(limit);
    if reach > RESULT_WINDOW {
        return Err(NarsilError::new(
            ErrorCode::SEARCH_RESULT_WINDOW_EXCEEDED,
            format!(
                "The engine pages a vector search through the first {RESULT_WINDOW} results, and this page ends at {reach}. Narrow the search with a filter or a similarity floor"
            ),
        ));
    }
    Ok((reach + 1).min(RESULT_WINDOW))
}

/// The vector hits of one search, with whether they hold every vector that passed the search.
pub(crate) struct VectorLeg {
    pub(crate) hits: Vec<KeywordHit>,
    pub(crate) matched: u64,
    pub(crate) exact: bool,
    pub(crate) holds_every_match: bool,
}

pub(crate) struct VectorLegRequest<'a> {
    pub(crate) clause: &'a VectorQuery,
    pub(crate) query: &'a [f32],
    pub(crate) k: usize,
    pub(crate) rescore_window: Option<usize>,
    pub(crate) matching: Option<&'a [&'a str]>,
    pub(crate) snapshots: &'a QuerySnapshots,
}

/// Searches the vector field of a clause that holds a value, keeping only the hits whose document the query's
/// partition snapshots hold, so that every hit carries the text and the vector of one write. Where `matching` lists
/// the IDs that a filter accepts, the search admits those documents alone.
pub(crate) fn vector_leg(index: &IndexState, request: &VectorLegRequest<'_>) -> Result<VectorLeg> {
    let VectorLegRequest {
        clause,
        query,
        k,
        rescore_window,
        matching,
        snapshots,
    } = *request;
    let Some(field) = index.vectors.field(&clause.field) else {
        return Ok(VectorLeg {
            hits: Vec::new(),
            matched: 0,
            exact: true,
            holds_every_match: true,
        });
    };
    let options = VectorSearchOptions {
        metric: clause.metric.unwrap_or(Metric::Cosine),
        min_similarity: clause.similarity.unwrap_or(f64::NEG_INFINITY),
        ef_search: clause.ef_search.map(|ef| ef as usize),
        oversample: clause.oversample,
        rescore_window,
    };
    let outcome = field.search(query, k, &options, matching, &snapshots.pin)?;
    let returned = outcome.results.len() as u64;
    let mut hits = Vec::with_capacity(outcome.results.len());
    for hit in outcome.results {
        if snapshots.locate(index, &hit.doc_id)?.is_some() {
            hits.push(KeywordHit {
                id: hit.doc_id,
                score: hit.score,
                components: Some(ScoreComponents::default()),
            });
        }
    }
    Ok(VectorLeg {
        hits,
        matched: outcome.matched,
        exact: outcome.matched_exact,
        holds_every_match: outcome.matched_exact && returned == outcome.matched,
    })
}

/// Returns the query's snapshot of every partition where the search carries a filter, which a filtered vector
/// search reads its matches from, and no snapshot otherwise.
pub(crate) fn filter_snapshots(
    snapshots: &QuerySnapshots,
    scope: &QueryScope,
) -> Vec<Arc<PartitionSnapshot>> {
    if !scope.filters() {
        return Vec::new();
    }
    snapshots.partitions.clone()
}

/// Returns the IDs that `ids` holds, borrowed, in the form that a vector search takes.
pub(crate) fn id_slices<'a>(ids: &'a Option<Vec<Cow<'_, str>>>) -> Option<Vec<&'a str>> {
    ids.as_ref()
        .map(|ids| ids.iter().map(|id| id.as_ref()).collect())
}

/// Refuses a vector clause whose `oversample` or `efSearch` lies outside its range, before any part of a vector or
/// hybrid search runs, so that the same query fails whatever the index holds.
pub(crate) fn require_usable_vector_options(clause: Option<&VectorQuery>) -> Result<()> {
    let Some(clause) = clause else {
        return Ok(());
    };
    VectorSearchOptions {
        ef_search: clause.ef_search.map(|ef| ef as usize),
        oversample: clause.oversample,
        ..VectorSearchOptions::default()
    }
    .validate(0)
}

/// Runs a vector-only query to the depth that its page needs, past the `cursor_depth` results that earlier pages
/// returned.
pub(crate) fn vector_hits(run: &QueryRun<'_>, cursor_depth: usize) -> Result<RankedHits> {
    let (index, params, scope) = (run.index, run.params, run.scope);
    require_usable_vector_options(params.vector.as_ref())?;
    let Some(clause) = &params.vector else {
        return Ok(RankedHits::empty());
    };
    let Some(query) = &clause.value else {
        return Ok(RankedHits::empty());
    };
    if index.vectors.field(&clause.field).is_none() {
        return Ok(RankedHits::empty());
    }
    let snapshots = filter_snapshots(&run.snapshots, scope);
    let matched = scope.matched_ids(&snapshots)?;
    if matched.as_ref().is_some_and(Vec::is_empty) {
        return Ok(RankedHits::empty());
    }
    let matching = id_slices(&matched);
    let leg = vector_leg(
        index,
        &VectorLegRequest {
            clause,
            query,
            k: vector_fetch_depth(run.limit, run.offset, cursor_depth)?,
            rescore_window: None,
            matching: matching.as_deref(),
            snapshots: &run.snapshots,
        },
    )?;
    Ok(RankedHits {
        hits: leg.hits,
        total_matched: leg.matched,
        exact: leg.exact,
        ..RankedHits::empty()
    })
}
