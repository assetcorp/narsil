use std::collections::BTreeMap;
use std::sync::Arc;

use narsil::{
    DocumentProjection, FacetResult, FacetSpec, GroupConfig, GroupReducer, GroupResult,
    HighlightConfig, HighlightMatch, Hit, Map, Pin, QueryParams, QueryResult, ScoreComponents,
    SortDirection, SortField, SortMode, Value,
};

use super::parity::query_params;

fn member<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    value.as_object().and_then(|map| map.get(name))
}

fn count(value: &Value) -> usize {
    value.as_f64().expect("a count") as usize
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("a list of strings")
        .iter()
        .map(|item| item.as_str().expect("a string").to_string())
        .collect()
}

fn direction(value: &Value) -> SortDirection {
    match value.as_str() {
        Some("desc") => SortDirection::Desc,
        _ => SortDirection::Asc,
    }
}

fn sort_mode(value: &Value) -> SortMode {
    match value.as_str() {
        Some("min") => SortMode::Min,
        Some("max") => SortMode::Max,
        Some("avg") => SortMode::Avg,
        _ => SortMode::Median,
    }
}

fn sort_fields(sort: &Value) -> Vec<SortField> {
    match sort {
        Value::Object(map) => map
            .iter()
            .map(|(field, order)| SortField {
                field: field.clone(),
                direction: direction(order),
                mode: None,
            })
            .collect(),
        Value::Array(entries) => entries
            .iter()
            .map(|entry| SortField {
                field: member(entry, "field")
                    .and_then(Value::as_str)
                    .expect("a sort field")
                    .to_string(),
                direction: direction(member(entry, "direction").expect("a direction")),
                mode: member(entry, "mode").map(sort_mode),
            })
            .collect(),
        _ => panic!("a sort is an object or a list"),
    }
}

fn facet_specs(facets: &Value) -> Vec<(String, FacetSpec)> {
    let map = facets.as_object().expect("an object of facets");
    map.iter()
        .map(|(field, spec)| {
            let ranges = member(spec, "ranges").map(|ranges| {
                ranges
                    .as_array()
                    .expect("a list of ranges")
                    .iter()
                    .map(|range| {
                        let bound = |name| {
                            member(range, name)
                                .and_then(Value::as_f64)
                                .expect("a bound")
                        };
                        (bound("from"), bound("to"))
                    })
                    .collect()
            });
            let facet = FacetSpec {
                limit: member(spec, "limit").map(count),
                sort: member(spec, "sort").map(direction),
                ranges,
            };
            (field.clone(), facet)
        })
        .collect()
}

fn year_of(document: &Map) -> Option<f64> {
    document.get("year").and_then(Value::as_f64)
}

fn named_reducer(name: &str) -> GroupReducer {
    match name {
        "scoreSum" => GroupReducer {
            reducer: Arc::new(|accumulator, _document, score| {
                Ok(Value::Number(accumulator.as_f64().unwrap_or(0.0) + score))
            }),
            initial_value: Arc::new(|| Value::Number(0.0)),
        },
        "yearList" => GroupReducer {
            reducer: Arc::new(|accumulator, document, _score| {
                let mut years = accumulator.as_array().cloned().unwrap_or_default();
                years.push(document.get("year").cloned().unwrap_or(Value::Null));
                Ok(Value::Array(years))
            }),
            initial_value: Arc::new(|| Value::Array(Vec::new())),
        },
        "failsOnOddYear" => GroupReducer {
            reducer: Arc::new(|accumulator, document, _score| match year_of(document) {
                Some(year) if year % 2.0 == 1.0 => Err(format!("the year {year} is odd")),
                _ => Ok(Value::Number(accumulator.as_f64().unwrap_or(0.0) + 1.0)),
            }),
            initial_value: Arc::new(|| Value::Number(0.0)),
        },
        other => panic!("no reducer is called {other}"),
    }
}

fn group_config(group: &Value) -> GroupConfig {
    GroupConfig {
        fields: member(group, "fields").map(strings).unwrap_or_default(),
        max_per_group: member(group, "maxPerGroup").map(count),
        limit: member(group, "limit").map(count),
        reduce: member(group, "reduce")
            .and_then(Value::as_str)
            .map(named_reducer),
    }
}

fn highlight_config(highlight: &Value) -> HighlightConfig {
    let tag = |name| {
        member(highlight, name)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    HighlightConfig {
        fields: member(highlight, "fields").map(strings).unwrap_or_default(),
        pre_tag: tag("preTag"),
        post_tag: tag("postTag"),
        max_snippet_length: member(highlight, "maxSnippetLength").map(count),
    }
}

fn projection(document: &Value) -> DocumentProjection {
    match document {
        Value::Bool(true) => DocumentProjection::All,
        Value::Bool(false) => DocumentProjection::None,
        _ => DocumentProjection::Fields {
            include: member(document, "include").map(strings),
            exclude: member(document, "exclude").map(strings),
        },
    }
}

fn pins(pinned: &Value) -> Vec<Pin> {
    pinned
        .as_array()
        .expect("a list of pins")
        .iter()
        .map(|pin| Pin {
            doc_id: member(pin, "docId")
                .and_then(Value::as_str)
                .expect("a pinned ID")
                .to_string(),
            position: member(pin, "position").map(count).expect("a position"),
        })
        .collect()
}

pub fn shaping_params(query: &Value) -> QueryParams {
    let field = |name: &str| member(query, name).filter(|value| !value.is_null());
    QueryParams {
        sort: field("sort").map(sort_fields),
        facets: field("facets").map(facet_specs),
        group: field("group").map(group_config),
        highlight: field("highlight").map(highlight_config),
        pinned: field("pinned").map(pins),
        search_after: field("searchAfter")
            .and_then(Value::as_str)
            .map(str::to_string),
        include_scores: field("includeScores").and_then(Value::as_bool),
        include_score_components: field("includeScoreComponents").and_then(Value::as_bool),
        document: field("document").map(projection),
        ..query_params(query)
    }
}

fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key, value);
    }
    Value::Object(map)
}

fn numbers(record: &BTreeMap<String, f64>) -> Value {
    let mut map = Map::new();
    for (key, value) in record {
        map.insert(key.clone(), Value::Number(*value));
    }
    Value::Object(map)
}

fn components_value(components: &ScoreComponents) -> Value {
    object(vec![
        ("termFrequencies", numbers(&components.term_frequencies)),
        ("fieldLengths", numbers(&components.field_lengths)),
        ("idf", numbers(&components.idf)),
    ])
}

fn highlight_value(highlight: &HighlightMatch) -> Value {
    let positions = highlight
        .positions
        .iter()
        .map(|position| {
            object(vec![
                ("start", Value::Number(position.start as f64)),
                ("end", Value::Number(position.end as f64)),
            ])
        })
        .collect();
    object(vec![
        ("snippet", Value::String(highlight.snippet.clone())),
        ("positions", Value::Array(positions)),
    ])
}

fn hit_value(hit: &Hit) -> Value {
    let highlights = hit.highlights.as_ref().map_or(Value::Null, |highlights| {
        let mut map = Map::new();
        for (field, highlight) in highlights {
            map.insert(field.clone(), highlight_value(highlight));
        }
        Value::Object(map)
    });
    object(vec![
        ("id", Value::String(hit.id.clone())),
        ("score", hit.score.map_or(Value::Null, Value::Number)),
        ("document", Value::Object(hit.document.clone())),
        (
            "scoreComponents",
            hit.score_components
                .as_ref()
                .map_or(Value::Null, components_value),
        ),
        ("highlights", highlights),
    ])
}

fn facet_value(facet: &FacetResult) -> Value {
    let mut values = Map::new();
    for (key, found) in &facet.values {
        values.insert(key.clone(), Value::Number(*found as f64));
    }
    object(vec![
        ("values", Value::Object(values)),
        ("count", Value::Number(facet.count as f64)),
        ("errorBound", Value::Number(facet.error_bound as f64)),
    ])
}

fn group_value(group: &GroupResult) -> Value {
    let mut values = Map::new();
    for (field, value) in &group.values {
        if let Some(value) = value {
            values.insert(field.clone(), value.clone());
        }
    }
    object(vec![
        ("values", Value::Object(values)),
        (
            "hits",
            Value::Array(group.hits.iter().map(hit_value).collect()),
        ),
        ("reduced", group.reduced.clone().unwrap_or(Value::Null)),
        (
            "reducerError",
            group
                .reducer_error
                .clone()
                .map_or(Value::Null, Value::String),
        ),
    ])
}

pub fn page_value(result: &QueryResult) -> Value {
    let facets = result.facets.as_ref().map_or(Value::Null, |facets| {
        let mut map = Map::new();
        for (field, facet) in facets {
            map.insert(field.clone(), facet_value(facet));
        }
        Value::Object(map)
    });
    let groups = result.groups.as_ref().map_or(Value::Null, |groups| {
        Value::Array(groups.iter().map(group_value).collect())
    });
    object(vec![
        ("count", Value::Number(result.count as f64)),
        ("countExact", Value::Bool(result.count_exact)),
        (
            "cursor",
            result.cursor.clone().map_or(Value::Null, Value::String),
        ),
        (
            "hits",
            Value::Array(result.hits.iter().map(hit_value).collect()),
        ),
        ("facets", facets),
        ("groups", groups),
    ])
}
