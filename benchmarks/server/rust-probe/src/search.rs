use narsil::{
    DocumentProjection, HybridConfig, HybridStrategy, Metric, QueryCoverage, QueryParams,
    QueryResult, SearchMode, Value, VectorQuery,
};
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::value::RawValue;

use crate::constants::MAX_RESULT_WINDOW;
use crate::errors::ApiError;
use crate::json::PlainValue;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchBody {
    term: Option<String>,
    fields: Option<Vec<String>>,
    limit: Option<usize>,
    offset: Option<usize>,
    mode: Option<String>,
    #[serde(default, deserialize_with = "crate::json::optional_object")]
    vector: Option<VectorClause>,
    #[serde(default, deserialize_with = "crate::json::optional_object")]
    hybrid: Option<HybridClause>,
    document: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VectorClause {
    field: String,
    value: Vec<f32>,
    metric: Option<String>,
    ef_search: Option<u32>,
    oversample: Option<f64>,
    similarity: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HybridClause {
    strategy: Option<String>,
    k: Option<f64>,
    alpha: Option<f64>,
    depth: Option<usize>,
}

pub fn parse_metric(name: &str) -> Result<Metric, ApiError> {
    match name {
        "cosine" => Ok(Metric::Cosine),
        "dotProduct" => Ok(Metric::DotProduct),
        "euclidean" => Ok(Metric::Euclidean),
        other => Err(ApiError::invalid(format!(
            "Field \"metric\" must be cosine, dotProduct, or euclidean, got \"{other}\""
        ))),
    }
}

fn parse_mode(name: &str) -> Result<SearchMode, ApiError> {
    match name {
        "fulltext" => Ok(SearchMode::Fulltext),
        "vector" => Ok(SearchMode::Vector),
        "hybrid" => Ok(SearchMode::Hybrid),
        other => Err(ApiError::invalid(format!(
            "Field \"mode\" must be fulltext, vector, or hybrid, got \"{other}\""
        ))),
    }
}

fn parse_strategy(name: &str) -> Result<HybridStrategy, ApiError> {
    match name {
        "rrf" => Ok(HybridStrategy::Rrf),
        "linear" => Ok(HybridStrategy::Linear),
        other => Err(ApiError::invalid(format!(
            "Field \"hybrid.strategy\" must be rrf or linear, got \"{other}\""
        ))),
    }
}

fn require_window(limit: Option<usize>, offset: Option<usize>) -> Result<(), ApiError> {
    let window = limit.unwrap_or(0).saturating_add(offset.unwrap_or(0));
    if window > MAX_RESULT_WINDOW {
        return Err(ApiError::invalid(format!(
            "Field \"limit\" exceeds the maximum result window of {MAX_RESULT_WINDOW}"
        )));
    }
    Ok(())
}

impl SearchBody {
    pub fn into_params(self) -> Result<QueryParams, ApiError> {
        require_window(self.limit, self.offset)?;
        let vector = match self.vector {
            None => None,
            Some(clause) => Some(VectorQuery {
                field: clause.field,
                value: Some(clause.value),
                metric: clause.metric.as_deref().map(parse_metric).transpose()?,
                ef_search: clause.ef_search,
                oversample: clause.oversample,
                similarity: clause.similarity,
                ..VectorQuery::default()
            }),
        };
        let hybrid = match self.hybrid {
            None => None,
            Some(clause) => Some(HybridConfig {
                strategy: clause.strategy.as_deref().map(parse_strategy).transpose()?,
                k: clause.k,
                alpha: clause.alpha,
                depth: clause.depth,
            }),
        };
        Ok(QueryParams {
            term: self.term,
            fields: self.fields,
            limit: self.limit,
            offset: self.offset,
            mode: self.mode.as_deref().map(parse_mode).transpose()?,
            vector,
            hybrid,
            document: self.document.map(|whole| {
                if whole {
                    DocumentProjection::All
                } else {
                    DocumentProjection::None
                }
            }),
            ..QueryParams::default()
        })
    }
}

enum WireDocument {
    Empty,
    Written(Box<RawValue>),
}

impl Serialize for WireDocument {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            WireDocument::Empty => serializer.serialize_map(Some(0))?.end(),
            WireDocument::Written(raw) => raw.serialize(serializer),
        }
    }
}

#[derive(Serialize)]
struct WireHit {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    score: Option<f64>,
    document: WireDocument,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireCoverage {
    total_partitions: usize,
    queried_partitions: usize,
    timed_out_partitions: usize,
    failed_partitions: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireResult {
    hits: Vec<WireHit>,
    count: u64,
    count_exact: bool,
    elapsed: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    analysis_stale: bool,
    coverage: WireCoverage,
}

fn wire_document(document: narsil::Map) -> Result<WireDocument, ApiError> {
    if document.is_empty() {
        return Ok(WireDocument::Empty);
    }
    let text = serde_json::to_string(&PlainValue(&Value::Object(document)))
        .map_err(|_| ApiError::internal("A stored document could not be written as JSON"))?;
    RawValue::from_string(text)
        .map(WireDocument::Written)
        .map_err(|_| ApiError::internal("A stored document could not be written as JSON"))
}

fn wire_coverage(coverage: &QueryCoverage) -> WireCoverage {
    WireCoverage {
        total_partitions: coverage.total_partitions,
        queried_partitions: coverage.queried_partitions,
        timed_out_partitions: coverage.timed_out_partitions,
        failed_partitions: coverage.failed_partitions,
    }
}

pub fn wire_result(result: QueryResult) -> Result<WireResult, ApiError> {
    if result.facets.is_some() || result.groups.is_some() {
        return Err(ApiError::internal(
            "This server answers no facet or group query",
        ));
    }
    let mut hits = Vec::with_capacity(result.hits.len());
    for hit in result.hits {
        hits.push(WireHit {
            id: hit.id,
            score: hit.score.filter(|score| score.is_finite()),
            document: wire_document(hit.document)?,
        });
    }
    Ok(WireResult {
        hits,
        count: result.count,
        count_exact: result.count_exact,
        elapsed: result.elapsed.as_secs_f64() * 1000.0,
        cursor: result.cursor,
        analysis_stale: result.analysis_stale,
        coverage: wire_coverage(&result.coverage),
    })
}
