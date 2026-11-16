use std::time::Duration;

use narsil::{
    FacetResult, GroupResult, HighlightMatch, Hit, ListResult, Map, PreflightResult, QueryCoverage,
    QueryResult, ScoreComponents, SuggestResult, Value,
};

use super::answer::Answer;
use super::constants::MILLISECONDS_PER_SECOND;

pub(crate) fn milliseconds(elapsed: Duration) -> Value {
    Value::Number(elapsed.as_secs_f64() * MILLISECONDS_PER_SECOND)
}

fn count(value: u64) -> Value {
    Value::Number(value as f64)
}

fn score_value(score: f64) -> Value {
    if score.is_finite() {
        Value::Number(score)
    } else if score.is_nan() {
        Value::String("NaN".to_string())
    } else if score > 0.0 {
        Value::String("Infinity".to_string())
    } else {
        Value::String("-Infinity".to_string())
    }
}

fn numbers(record: Vec<(String, f64)>) -> Value {
    let mut map = Map::with_capacity(record.len());
    for (key, number) in record {
        map.insert(key, Value::Number(number));
    }
    Value::Object(map)
}

fn components_value(components: ScoreComponents) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("termFrequencies", numbers(components.term_frequencies));
    map.insert("fieldLengths", numbers(components.field_lengths));
    map.insert("idf", numbers(components.idf));
    Value::Object(map)
}

fn highlight_value(highlight: HighlightMatch) -> Value {
    let positions = highlight
        .positions
        .iter()
        .map(|position| {
            let mut entry = Map::with_capacity(2);
            entry.insert("start", count(position.start as u64));
            entry.insert("end", count(position.end as u64));
            Value::Object(entry)
        })
        .collect();
    let mut map = Map::with_capacity(2);
    map.insert("snippet", Value::String(highlight.snippet));
    map.insert("positions", Value::Array(positions));
    Value::Object(map)
}

fn hit_value(hit: Hit) -> Value {
    let mut map = Map::with_capacity(5);
    map.insert("id", Value::String(hit.id));
    if let Some(score) = hit.score {
        map.insert("score", score_value(score));
    }
    map.insert("document", Value::Object(hit.document));
    if let Some(components) = hit.score_components {
        map.insert("scoreComponents", components_value(components));
    }
    if let Some(highlights) = hit.highlights {
        let mut fields = Map::with_capacity(highlights.len());
        for (field, highlight) in highlights {
            fields.insert(field, highlight_value(highlight));
        }
        map.insert("highlights", Value::Object(fields));
    }
    Value::Object(map)
}

fn facet_value(facet: FacetResult) -> Value {
    let mut values = Map::with_capacity(facet.values.len());
    for (value, found) in facet.values {
        values.insert(value, count(found));
    }
    let mut map = Map::with_capacity(3);
    map.insert("values", Value::Object(values));
    map.insert("count", count(facet.count as u64));
    map.insert("errorBound", count(facet.error_bound));
    Value::Object(map)
}

fn group_value(group: GroupResult) -> Value {
    let mut values = Map::with_capacity(group.values.len());
    for (field, value) in group.values {
        values.insert(field, value.unwrap_or(Value::Null));
    }
    let mut map = Map::with_capacity(4);
    map.insert("values", Value::Object(values));
    map.insert(
        "hits",
        Value::Array(group.hits.into_iter().map(hit_value).collect()),
    );
    if let Some(reduced) = group.reduced {
        map.insert("reduced", reduced);
    }
    if let Some(reducer_error) = group.reducer_error {
        map.insert("reducerError", Value::String(reducer_error));
    }
    Value::Object(map)
}

fn coverage_value(coverage: QueryCoverage) -> Value {
    let mut map = Map::with_capacity(4);
    map.insert("totalPartitions", count(coverage.total_partitions as u64));
    map.insert(
        "queriedPartitions",
        count(coverage.queried_partitions as u64),
    );
    map.insert(
        "timedOutPartitions",
        count(coverage.timed_out_partitions as u64),
    );
    map.insert("failedPartitions", count(coverage.failed_partitions as u64));
    Value::Object(map)
}

pub(crate) fn query_answer(result: QueryResult) -> Answer {
    let mut rest = Map::with_capacity(8);
    rest.insert("count", count(result.count));
    rest.insert("countExact", Value::Bool(result.count_exact));
    rest.insert("elapsed", milliseconds(result.elapsed));
    if let Some(cursor) = result.cursor {
        rest.insert("cursor", Value::String(cursor));
    }
    if let Some(facets) = result.facets {
        let mut map = Map::with_capacity(facets.len());
        for (field, facet) in facets {
            map.insert(field, facet_value(facet));
        }
        rest.insert("facets", Value::Object(map));
    }
    if let Some(groups) = result.groups {
        rest.insert(
            "groups",
            Value::Array(groups.into_iter().map(group_value).collect()),
        );
    }
    rest.insert("coverage", coverage_value(result.coverage));
    if result.analysis_stale {
        rest.insert("analysisStale", Value::Bool(true));
    }
    Answer {
        key: "hits",
        items: result.hits.into_iter().map(hit_value).collect(),
        rest,
    }
}

pub(crate) fn preflight_value(result: PreflightResult) -> Value {
    let mut map = Map::with_capacity(4);
    map.insert("count", count(result.count));
    map.insert("countExact", Value::Bool(result.count_exact));
    map.insert("elapsed", milliseconds(result.elapsed));
    if result.analysis_stale {
        map.insert("analysisStale", Value::Bool(true));
    }
    Value::Object(map)
}

pub(crate) fn suggest_value(result: SuggestResult) -> Value {
    let terms = result
        .terms
        .into_iter()
        .map(|suggested| {
            let mut entry = Map::with_capacity(2);
            entry.insert("term", Value::String(suggested.term));
            entry.insert("documentFrequency", count(suggested.document_frequency));
            Value::Object(entry)
        })
        .collect();
    let mut map = Map::with_capacity(3);
    map.insert("terms", Value::Array(terms));
    map.insert("elapsed", milliseconds(result.elapsed));
    if result.analysis_stale {
        map.insert("analysisStale", Value::Bool(true));
    }
    Value::Object(map)
}

pub(crate) fn list_answer(result: ListResult) -> Answer {
    let items = result
        .documents
        .into_iter()
        .map(|listed| {
            let mut entry = Map::with_capacity(2);
            entry.insert("id", Value::String(listed.id));
            entry.insert("document", Value::Object(listed.document));
            Value::Object(entry)
        })
        .collect();
    let mut rest = Map::with_capacity(3);
    rest.insert("cursor", result.cursor.map_or(Value::Null, Value::String));
    rest.insert("total", count(result.total));
    rest.insert("elapsed", milliseconds(result.elapsed));
    Answer {
        key: "documents",
        items,
        rest,
    }
}
