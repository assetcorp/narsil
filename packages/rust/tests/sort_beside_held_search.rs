mod support;

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use narsil::{
    IndexConfig, Map, Narsil, QueryParams, RerankConfig, SortDirection, SortField, Value,
    parse_json,
};
use support::adapters::RerankWith;

const INDEX: &str = "rivers";
const HELD_ADAPTER: &str = "held";
const FIRST_BATCH: u64 = 1_500;
const SECOND_BATCH: u64 = 1_300;
const PAGE_LIMIT: usize = 37;
const LONGEST_SORTED_SEARCH: Duration = Duration::from_secs(60);
const HELD_SEARCH_START: Duration = Duration::from_secs(30);
const HELD_SEARCH_RELEASE: Duration = Duration::from_secs(120);

#[derive(Clone, Debug)]
enum Price {
    Missing,
    One(f64),
    Several(Vec<f64>),
}

struct Fixture {
    price: Price,
    rank: Option<f64>,
}

fn fixture(n: u64) -> Fixture {
    let base = ((n * 37) % 23) as f64 - 11.0;
    let price = match n % 9 {
        0 => Price::Missing,
        1 | 4 => Price::Several(vec![base + 5.0, base - 0.5, ((n * 11) % 17) as f64]),
        7 => Price::Several(Vec::new()),
        _ => Price::One(base),
    };
    let rank = match n % 13 {
        0 => None,
        _ => Some(((n * 7) % 5) as f64),
    };
    Fixture { price, rank }
}

fn document(n: u64) -> Map {
    let held = fixture(n);
    let mut map = Map::new();
    map.insert("id", Value::String(format!("doc-{n:05}")));
    map.insert("title", Value::String(format!("river crossing {n}")));
    match &held.price {
        Price::Missing => {}
        Price::One(price) => {
            map.insert("price", Value::Array(vec![Value::Number(*price)]));
        }
        Price::Several(prices) => {
            map.insert(
                "price",
                Value::Array(prices.iter().map(|price| Value::Number(*price)).collect()),
            );
        }
    }
    if let Some(rank) = held.rank {
        map.insert("rank", Value::Number(rank));
    }
    map
}

fn lowest_price(price: &Price) -> Option<f64> {
    match price {
        Price::Missing => None,
        Price::One(price) => Some(*price),
        Price::Several(prices) => prices.iter().copied().reduce(f64::min),
    }
}

fn missing_last(left: Option<f64>, right: Option<f64>, descending: bool) -> Ordering {
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(one), Some(other)) if descending => other.total_cmp(&one),
        (Some(one), Some(other)) => one.total_cmp(&other),
    }
}

fn expected_order(count: u64) -> Vec<String> {
    let mut held: Vec<(String, Option<f64>, Option<f64>)> = (0..count)
        .map(|n| {
            let fixture = fixture(n);
            (
                format!("doc-{n:05}"),
                lowest_price(&fixture.price),
                fixture.rank,
            )
        })
        .collect();
    held.sort_by(|left, right| {
        missing_last(left.1, right.1, false)
            .then_with(|| missing_last(left.2, right.2, true))
            .then_with(|| left.0.cmp(&right.0))
    });
    held.into_iter().map(|(id, _, _)| id).collect()
}

fn sorted_query(cursor: Option<String>) -> QueryParams {
    QueryParams {
        term: Some("river".into()),
        sort: Some(vec![
            SortField {
                field: "price".into(),
                direction: SortDirection::Asc,
                mode: None,
            },
            SortField {
                field: "rank".into(),
                direction: SortDirection::Desc,
                mode: None,
            },
        ]),
        limit: Some(PAGE_LIMIT),
        search_after: cursor,
        ..QueryParams::default()
    }
}

fn every_sorted_page(engine: &Narsil) -> Vec<String> {
    let mut found = Vec::new();
    let mut cursor = None;
    loop {
        let result = engine
            .query(INDEX, &sorted_query(cursor))
            .expect("the sorted query answers");
        found.extend(result.hits.iter().map(|hit| hit.id.clone()));
        match result.cursor {
            Some(next) => cursor = Some(next),
            None => return found,
        }
    }
}

fn insert_range(engine: &Narsil, from: u64, to: u64) {
    let batch = engine
        .insert_batch(INDEX, (from..to).map(document).collect())
        .expect("the batch is inserted");
    assert!(
        batch.failed.is_empty(),
        "a document was refused: {:?}",
        batch.failed.first()
    );
}

fn held_rerank(
    entered: Sender<()>,
    release: Receiver<()>,
) -> RerankWith<impl Fn(&str, &[String]) -> Result<Vec<f64>, narsil::AdapterError> + Send + Sync> {
    let entered = Mutex::new(entered);
    let release = Mutex::new(release);
    RerankWith(move |_: &str, documents: &[String]| {
        if let Ok(entered) = entered.lock() {
            let _ = entered.send(());
        }
        if let Ok(release) = release.lock() {
            let _ = release.recv_timeout(HELD_SEARCH_RELEASE);
        }
        Ok(vec![0.0; documents.len()])
    })
}

#[test]
fn a_search_that_sorts_on_a_new_field_finishes_while_another_search_is_held_open() {
    let engine = Narsil::new();
    engine
        .create_index(
            INDEX,
            IndexConfig {
                schema: parse_json(r#"{"title": "string", "price": "number[]", "rank": "number"}"#)
                    .expect("the schema is JSON"),
                ..IndexConfig::default()
            },
        )
        .expect("the index is created");
    insert_range(&engine, 0, FIRST_BATCH);
    let (entered_sender, entered) = channel();
    let (release, release_receiver) = channel();
    engine
        .register_rerank_adapter(
            HELD_ADAPTER,
            Arc::new(held_rerank(entered_sender, release_receiver)),
        )
        .expect("the adapter is registered");

    std::thread::scope(|scope| {
        let held = scope.spawn(|| {
            engine.query(
                INDEX,
                &QueryParams {
                    term: Some("crossing".into()),
                    rerank: Some(RerankConfig {
                        adapter: HELD_ADAPTER.to_string(),
                        fields: vec!["title".into()],
                        ..RerankConfig::default()
                    }),
                    ..QueryParams::default()
                },
            )
        });
        entered
            .recv_timeout(HELD_SEARCH_START)
            .expect("the held search reaches its adapter");
        let (finished, sorted) = channel();
        let reader = &engine;
        scope.spawn(move || {
            let _ = finished.send(every_sorted_page(reader));
        });
        let pages = sorted
            .recv_timeout(LONGEST_SORTED_SEARCH)
            .expect("the sorted search finishes while the other search is held open");
        assert_eq!(pages, expected_order(FIRST_BATCH));
        let _ = release.send(());
        held.join()
            .expect("the held search returns")
            .expect("the held search answers");
    });

    insert_range(&engine, FIRST_BATCH, FIRST_BATCH + SECOND_BATCH);
    assert_eq!(
        every_sorted_page(&engine),
        expected_order(FIRST_BATCH + SECOND_BATCH)
    );
    let removed: BTreeMap<u64, ()> = (0..FIRST_BATCH + SECOND_BATCH)
        .filter(|n| n % 6 == 0)
        .map(|n| (n, ()))
        .collect();
    for n in removed.keys() {
        engine
            .remove(INDEX, &format!("doc-{n:05}"))
            .expect("the document is removed");
    }
    let remaining: Vec<String> = expected_order(FIRST_BATCH + SECOND_BATCH)
        .into_iter()
        .filter(|id| {
            let n: u64 = id[4..].parse().expect("the id holds a number");
            !removed.contains_key(&n)
        })
        .collect();
    assert_eq!(every_sorted_page(&engine), remaining);
}
