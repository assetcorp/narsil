use super::binding::{
    ABSENT_TAG, FALSE_TAG, LIST_TAG, MAP_TAG, TRUE_TAG, write_length, write_number, write_string,
    write_value,
};
use crate::config::{Bm25Params, ScoringMode};
use crate::engine::query::params::{
    HybridConfig, HybridStrategy, QueryParams, RerankConfig, SearchMode, TermMatch, VectorQuery,
};
use crate::util::hash::fnv1a;
use crate::value::Value;

enum Bound<'a> {
    Absent,
    Bool(bool),
    Number(f64),
    Text(&'a str),
    List(Vec<Bound<'a>>),
    Map(Vec<(String, Bound<'a>)>),
    Value(&'a Value),
    Floats(&'a [f32]),
}

fn write_bound(out: &mut Vec<u8>, bound: &Bound<'_>) {
    match bound {
        Bound::Absent => out.push(ABSENT_TAG),
        Bound::Bool(flag) => out.push(if *flag { TRUE_TAG } else { FALSE_TAG }),
        Bound::Number(number) => write_number(out, *number),
        Bound::Text(text) => write_string(out, text),
        Bound::List(items) => {
            out.push(LIST_TAG);
            write_length(out, items.len());
            for item in items {
                write_bound(out, item);
            }
        }
        Bound::Map(entries) => {
            let mut sorted: Vec<&(String, Bound<'_>)> = entries.iter().collect();
            sorted.sort_by(|left, right| left.0.cmp(&right.0));
            out.push(MAP_TAG);
            write_length(out, sorted.len());
            for (key, value) in sorted {
                write_string(out, key);
                write_bound(out, value);
            }
        }
        Bound::Value(value) => write_value(out, value),
        Bound::Floats(numbers) => {
            out.push(LIST_TAG);
            write_length(out, numbers.len());
            for number in numbers.iter() {
                write_number(out, f64::from(*number));
            }
        }
    }
}

fn optional<T>(value: Option<T>, bound: impl FnOnce(T) -> Bound<'static>) -> Bound<'static> {
    value.map_or(Bound::Absent, bound)
}

fn keyed<'a>(entries: Vec<(&str, Option<Bound<'a>>)>) -> Bound<'a> {
    Bound::Map(
        entries
            .into_iter()
            .filter_map(|(key, value)| value.map(|value| (key.to_string(), value)))
            .collect(),
    )
}

fn last_wins<T: Copy>(pairs: &[(String, T)]) -> Vec<(String, T)> {
    let mut kept: Vec<(String, T)> = Vec::with_capacity(pairs.len());
    for (key, value) in pairs {
        match kept.iter_mut().find(|held| &held.0 == key) {
            Some(held) => held.1 = *value,
            None => kept.push((key.clone(), *value)),
        }
    }
    kept
}

fn term_match_bound(policy: TermMatch) -> Bound<'static> {
    match policy {
        TermMatch::All => Bound::Text("all"),
        TermMatch::Any => Bound::Text("any"),
        TermMatch::AtLeast(count) => Bound::Number(f64::from(count)),
    }
}

fn mode_bound(mode: SearchMode) -> Bound<'static> {
    Bound::Text(match mode {
        SearchMode::Fulltext => "fulltext",
        SearchMode::Vector => "vector",
        SearchMode::Hybrid => "hybrid",
    })
}

fn hybrid_bound(hybrid: &HybridConfig) -> Bound<'static> {
    keyed(vec![
        ("alpha", hybrid.alpha.map(Bound::Number)),
        (
            "depth",
            hybrid.depth.map(|depth| Bound::Number(depth as f64)),
        ),
        ("k", hybrid.k.map(Bound::Number)),
        (
            "strategy",
            hybrid.strategy.map(|strategy| {
                Bound::Text(match strategy {
                    HybridStrategy::Rrf => "rrf",
                    HybridStrategy::Linear => "linear",
                })
            }),
        ),
    ])
}

fn vector_bound(vector: &VectorQuery) -> Bound<'_> {
    let value = match vector.text {
        Some(_) => None,
        None => vector.value.as_deref().map(Bound::Floats),
    };
    keyed(vec![
        (
            "efSearch",
            vector.ef_search.map(|size| Bound::Number(f64::from(size))),
        ),
        ("field", Some(Bound::Text(&vector.field))),
        (
            "metric",
            vector.metric.map(|metric| Bound::Text(metric.name())),
        ),
        ("oversample", vector.oversample.map(Bound::Number)),
        ("similarity", vector.similarity.map(Bound::Number)),
        ("text", vector.text.as_deref().map(Bound::Text)),
        ("value", value),
    ])
}

fn rerank_bound(rerank: &RerankConfig) -> Bound<'_> {
    keyed(vec![
        ("adapter", Some(Bound::Text(&rerank.adapter))),
        (
            "fields",
            Some(Bound::List(
                rerank
                    .fields
                    .iter()
                    .map(|field| Bound::Text(field))
                    .collect(),
            )),
        ),
        ("query", rerank.query.as_deref().map(Bound::Text)),
        (
            "window",
            rerank.window.map(|window| Bound::Number(window as f64)),
        ),
    ])
}

fn bm25_sets_value(bm25: &Bm25Params) -> bool {
    bm25.k1.is_some()
        || bm25.b.is_some()
        || bm25.fields.as_ref().is_some_and(|fields| {
            fields
                .iter()
                .any(|(_, pair)| pair.k1.is_some() || pair.b.is_some())
        })
}

fn bm25_bound(bm25: &Bm25Params) -> Bound<'static> {
    let fields = bm25.fields.as_deref().map(last_wins).unwrap_or_default();
    let bound_fields: Vec<(String, Bound<'static>)> = fields
        .into_iter()
        .filter(|(_, pair)| pair.k1.is_some() || pair.b.is_some())
        .map(|(name, pair)| {
            (
                name,
                keyed(vec![
                    ("b", pair.b.map(Bound::Number)),
                    ("k1", pair.k1.map(Bound::Number)),
                ]),
            )
        })
        .collect();
    keyed(vec![
        ("b", bm25.b.map(Bound::Number)),
        (
            "fields",
            (!bound_fields.is_empty()).then_some(Bound::Map(bound_fields)),
        ),
        ("k1", bm25.k1.map(Bound::Number)),
    ])
}

fn pinned_bound(params: &QueryParams) -> Bound<'_> {
    params.pinned.as_ref().map_or(Bound::Absent, |pins| {
        Bound::List(
            pins.iter()
                .map(|pin| {
                    keyed(vec![
                        ("docId", Some(Bound::Text(&pin.doc_id))),
                        ("position", Some(Bound::Number(pin.position as f64))),
                    ])
                })
                .collect(),
        )
    })
}

fn bound_values(params: &QueryParams) -> Vec<Bound<'_>> {
    let mut values = vec![
        params.term.as_deref().map_or(Bound::Absent, Bound::Text),
        params.fields.as_ref().map_or(Bound::Absent, |fields| {
            Bound::List(fields.iter().map(|field| Bound::Text(field)).collect())
        }),
        params.filters.as_ref().map_or(Bound::Absent, Bound::Value),
        params.boost.as_deref().map_or(Bound::Absent, |boost| {
            Bound::Map(
                last_wins(boost)
                    .into_iter()
                    .map(|(field, weight)| (field, Bound::Number(weight)))
                    .collect(),
            )
        }),
        optional(params.min_score, Bound::Number),
        optional(params.term_match, term_match_bound),
        optional(params.tolerance, |tolerance| {
            Bound::Number(f64::from(tolerance))
        }),
        optional(params.prefix_length, |length| {
            Bound::Number(f64::from(length))
        }),
        optional(params.prefix, Bound::Bool),
        optional(params.partial_words, Bound::Bool),
        optional(params.exact, Bound::Bool),
        pinned_bound(params),
        optional(params.mode, mode_bound),
        params.hybrid.as_ref().map_or(Bound::Absent, hybrid_bound),
        params.vector.as_ref().map_or(Bound::Absent, vector_bound),
        Bound::Text(params.scoring.unwrap_or(ScoringMode::Local).name()),
    ];
    if let Some(rerank) = &params.rerank {
        values.push(rerank_bound(rerank));
    }
    if let Some(bm25) = params.bm25.as_ref().filter(|bm25| bm25_sets_value(bm25)) {
        values.push(bm25_bound(bm25));
    }
    values
}

pub(crate) fn query_binding_of(params: &QueryParams) -> String {
    let mut out = Vec::with_capacity(256);
    for bound in bound_values(params) {
        write_bound(&mut out, &bound);
    }
    format!("{:08x}", fnv1a(&out))
}
