use std::ops::Range;

use narsil::{Map, Value, write_json};

use super::parity_cases::chosen_writes;
use super::shaping::{
    ShapingSpec, augment, crate_engine, crate_pages, reference_pages, shaping_documents,
};
use super::shaping_json::shaping_params;

const SHAPING_INDEX_NAME: &str = "bills";
const AUGMENTED_UPDATE_SEED: u64 = 20_000;
const MIN_ANSWERED_PAGES: usize = 10;
const LATE_DOCUMENTS: usize = 40;
const LATE_YEAR_HIGH: f64 = 2100.0;
const LATE_YEAR_LOW: f64 = 1900.0;
const SPREAD_COPIES: usize = 3;
const SPREAD_MAX_PARTITIONS: u64 = 4;
const MIN_SPREAD_PARTITIONS: usize = 2;

fn first_difference(path: &str, found: &Value, wanted: &Value) -> Option<String> {
    match (found, wanted) {
        (Value::Object(one), Value::Object(other)) => {
            let keys_one: Vec<&String> = one.keys().collect();
            let keys_other: Vec<&String> = other.keys().collect();
            if keys_one != keys_other {
                return Some(format!("{path}: keys {keys_one:?} against {keys_other:?}"));
            }
            one.iter().find_map(|(key, value)| {
                first_difference(
                    &format!("{path}.{key}"),
                    value,
                    other.get(key).unwrap_or(&Value::Null),
                )
            })
        }
        (Value::Array(one), Value::Array(other)) if one.len() == other.len() => one
            .iter()
            .zip(other)
            .enumerate()
            .find_map(|(at, (left, right))| {
                first_difference(&format!("{path}[{at}]"), left, right)
            }),
        _ if found == wanted => None,
        _ => {
            let shown = |value: &Value| write_json(value).chars().take(600).collect::<String>();
            Some(format!(
                "{path}:\n    crate:     {}\n    reference: {}",
                shown(found),
                shown(wanted)
            ))
        }
    }
}

fn require_same_pages(queries: &[(Value, usize)], found: &[Vec<Value>], wanted: &[Vec<Value>]) {
    assert_eq!(found.len(), wanted.len(), "both sides answer every query");
    let problems: Vec<String> = queries
        .iter()
        .zip(found.iter().zip(wanted))
        .filter_map(|((query, _), (found, wanted))| {
            let found = Value::Array(found.clone());
            let wanted = Value::Array(wanted.clone());
            first_difference("pages", &found, &wanted)
                .map(|problem| format!("{}\n  {problem}", write_json(query)))
        })
        .collect();
    assert!(
        problems.is_empty(),
        "{} of {} queries differ:\n{}",
        problems.len(),
        found.len(),
        problems.join("\n")
    );
}

fn writes() -> (Vec<String>, Vec<(String, Map)>) {
    let (removals, updates) = chosen_writes();
    let updates = updates
        .into_iter()
        .enumerate()
        .map(|(at, (id, mut document))| {
            augment(&mut document, AUGMENTED_UPDATE_SEED + at as u64);
            (id, document)
        })
        .collect();
    (removals, updates)
}

fn late_documents(documents: &[Map]) -> Vec<Map> {
    documents
        .iter()
        .take(LATE_DOCUMENTS)
        .enumerate()
        .map(|(at, source)| {
            let mut document = source.clone();
            let year = match at % 2 {
                0 => LATE_YEAR_HIGH + at as f64,
                _ => LATE_YEAR_LOW - at as f64,
            };
            let title = source.get("title").and_then(Value::as_str).unwrap_or("");
            document.insert("id", Value::String(format!("late-{at:03}")));
            document.insert("title", Value::String(format!("{title} tax health care")));
            document.insert("year", Value::Number(year));
            document.insert("chamber", Value::String("late".to_string()));
            document.insert("code", Value::String(format!("AAA late {at}")));
            document.insert(
                "topics",
                Value::Array(vec![Value::String("late".to_string())]),
            );
            document
        })
        .collect()
}

struct ComparedPages {
    queries: Vec<(Value, usize)>,
    found: Vec<Vec<Value>>,
    wanted: Vec<Vec<Value>>,
}

fn require_answered(wanted: &[Vec<Value>]) {
    let answered = wanted
        .iter()
        .flatten()
        .filter(|page| {
            page.pointer("hits")
                .and_then(Value::as_array)
                .is_some_and(|hits| !hits.is_empty())
        })
        .count();
    assert!(
        answered >= MIN_ANSWERED_PAGES,
        "only {answered} reference pages hold hits"
    );
}

fn compared_pages(
    queries: Vec<(Value, usize)>,
    copies: usize,
    max_partitions: Option<u64>,
) -> ComparedPages {
    let (removals, updates) = writes();
    let documents = shaping_documents(copies);
    let spec = ShapingSpec {
        index: SHAPING_INDEX_NAME.to_string(),
        max_partitions,
        late_documents: late_documents(&documents),
        removals,
        updates,
        queries,
    };
    let wanted = reference_pages(&spec, &documents);
    let engine = crate_engine(&spec, &documents);
    if max_partitions.is_some() {
        let probe = shaping_params(&step(r#"{"term": "tax"}"#, 1).0);
        let partitions = engine
            .query(&spec.index, &probe)
            .expect("the probe query answers")
            .coverage
            .total_partitions;
        assert!(
            partitions >= MIN_SPREAD_PARTITIONS,
            "the index holds {partitions} partitions, so no query spreads"
        );
    }
    let found = crate_pages(&spec, &engine);
    ComparedPages {
        queries: spec.queries,
        found,
        wanted,
    }
}

pub fn require_spread_parity(queries: Vec<(Value, usize)>) {
    let compared = compared_pages(queries, SPREAD_COPIES, Some(SPREAD_MAX_PARTITIONS));
    require_answered(&compared.wanted);
    require_same_pages(&compared.queries, &compared.found, &compared.wanted);
}

pub struct SharedParity {
    compared: ComparedPages,
    groups: Vec<Range<usize>>,
}

impl SharedParity {
    pub fn new(groups: Vec<Vec<(Value, usize)>>) -> SharedParity {
        let mut ranges = Vec::with_capacity(groups.len());
        let mut queries = Vec::new();
        for group in groups {
            let start = queries.len();
            queries.extend(group);
            ranges.push(start..queries.len());
        }
        SharedParity {
            compared: compared_pages(queries, 1, None),
            groups: ranges,
        }
    }

    pub fn require(&self, queries: &[(Value, usize)]) {
        let range = self
            .groups
            .iter()
            .find(|range| &self.compared.queries[(*range).clone()] == queries)
            .expect("the shared comparison holds these queries")
            .clone();
        let wanted = &self.compared.wanted[range.clone()];
        require_answered(wanted);
        require_same_pages(queries, &self.compared.found[range], wanted);
    }
}

pub fn step(json: &str, pages: usize) -> (Value, usize) {
    (narsil::parse_json(json).expect("the query is JSON"), pages)
}
